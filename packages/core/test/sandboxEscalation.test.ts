// sandboxEscalation.test.ts — ADR-070 step 2: denial markers, escalation choreography, one-call grants.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escalationHintMarker, parseEscalation, sandboxDenialMarker } from '../src/sandbox/escalation'
import { scheduleTools } from '../src/tools/scheduler'
import { BashTool } from '../src/tools/builtins/Bash'
import { WriteTool } from '../src/tools/builtins/Write'
import type { ToolContext } from '../src/tools/Tool'
import type { ActivityEvent, ContentBlock } from '../src/protocol'
import type { ExecOptions, Sandbox } from '../src/sandbox/sandbox'
import type { SandboxPolicy } from '../src/sandbox/policy'

const cwd = mkdtempSync(join(tmpdir(), 'sbxesc-'))
const signal = new AbortController().signal

const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace' }
const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/workspace' }

/** A fake sandbox that records each exec's command + options and returns a scripted result. */
function fakeSandbox(result = { output: '', exitCode: 0 }): Sandbox & { calls: { command: string; opts?: ExecOptions }[] } {
  const calls: { command: string; opts?: ExecOptions }[] = []
  return {
    root: '/workspace',
    shell: 'posix',
    enforcement: 'full',
    denialSignatures: ['read-only file system', 'permission denied'],
    calls,
    async exec(command: string, opts?: ExecOptions) {
      calls.push({ command, opts })
      return result
    },
    async dispose() {},
  }
}

/** Auto-answering permission controller in bypass mode: the normal gate never prompts, so the ONLY
 *  request() calls observed are escalation asks — exactly the web-builder deployment shape. */
function fakePerm(answer: 'allow' | 'allow-always' | 'deny') {
  return {
    state: { mode: 'bypass' as const, allow: new Set<string>(), deny: new Set<string>() },
    request: vi.fn(async () => answer),
  }
}

/** Drive the scheduler generator to completion, collecting activity events and result blocks. */
async function run(toolUses: { id: string; name: string; input: unknown }[], ctx: ToolContext) {
  const events: ActivityEvent[] = []
  const gen = scheduleTools(toolUses as never, ctx)
  let r = await gen.next()
  while (!r.done) {
    events.push(r.value)
    r = await gen.next()
  }
  return { events, blocks: r.value as ContentBlock[] }
}

const resultText = (b: ContentBlock) => (b.type === 'tool_result' ? b.content : '')

describe('marker texts — pinned verbatim (the one vocabulary every family teaches)', () => {
  it('denial marker', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })
  it('escalation hint', () => {
    expect(escalationHintMarker('command')).toBe(
      '[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
    )
  })
})

describe('parseEscalation — malformed pairings rejected, non-widening never valid', () => {
  it('no escalation fields → undefined (the common case costs nothing)', () => {
    expect(parseEscalation({ command: 'ls' }, wsWrite)).toBeUndefined()
  })
  it('sandbox_permissions without justification', () => {
    expect(parseEscalation({ sandbox_permissions: 'danger-full-access' }, wsWrite)).toEqual({
      error: 'invalid escalation: sandbox_permissions requires a justification',
    })
  })
  it('justification without sandbox_permissions', () => {
    expect(parseEscalation({ justification: 'because' }, wsWrite)).toEqual({
      error: 'invalid escalation: justification is only valid together with sandbox_permissions',
    })
  })
  it('blank justification', () => {
    expect(parseEscalation({ sandbox_permissions: 'danger-full-access', justification: '  ' }, wsWrite)).toEqual({
      error: 'invalid justification: expected a non-empty sentence',
    })
  })
  it('no confined policy active', () => {
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'x' }, undefined)).toMatchObject({
      error: expect.stringContaining('not applicable'),
    })
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'x' }, { mode: 'danger-full-access', workspaceRoot: '/w' })).toMatchObject({
      error: expect.stringContaining('not applicable'),
    })
  })
  it('non-widening request', () => {
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'x' }, wsWrite)).toEqual({
      error: 'sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "workspace-write" mode',
    })
  })
  it('a strictly wider request is a valid ask', () => {
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'need to write' }, readOnly)).toEqual({
      ask: { mode: 'workspace-write', justification: 'need to write' },
    })
  })
})

describe('read-only fences (in-process — real today, backend or not)', () => {
  it('Bash denies a mutating command with marker + hint, before any spawn', async () => {
    const sandbox = fakeSandbox()
    const res = await BashTool.call({ command: 'touch x.txt' }, { cwd, abortSignal: signal, sandbox, sandboxPolicy: readOnly })
    expect(res.isError).toBe(true)
    expect(res.content).toContain(sandboxDenialMarker('read-only'))
    expect(res.content).toContain(escalationHintMarker('command'))
    expect(sandbox.calls).toHaveLength(0) // fenced before exec
  })
  it('Bash still allows a read-only command under read-only policy', async () => {
    const sandbox = fakeSandbox({ output: 'hi', exitCode: 0 })
    const res = await BashTool.call({ command: 'echo hi' }, { cwd, abortSignal: signal, sandbox, sandboxPolicy: readOnly })
    expect(res.isError).toBe(false)
    expect(sandbox.calls).toHaveLength(1)
  })
  it('Write denies with marker + hint before touching the filesystem', async () => {
    const res = await WriteTool.call({ file_path: 'a.txt', content: 'x' }, { cwd, abortSignal: signal, sandboxPolicy: readOnly })
    expect(res.isError).toBe(true)
    expect(res.content).toContain(sandboxDenialMarker('read-only'))
    expect(res.content).toContain(escalationHintMarker('operation'))
  })
  it('no policy ⇒ no fence (the extension path is untouched)', async () => {
    const res = await WriteTool.call({ file_path: 'ok.txt', content: 'x' }, { cwd, abortSignal: signal })
    expect(res.isError).toBeFalsy()
  })
})

describe('denial classification (sandbox stderr speaks the backend dialect)', () => {
  it('a failed command matching denialSignatures gets marker + hint appended', async () => {
    const sandbox = fakeSandbox({ output: 'sh: cannot create /etc/x: Read-only file system', exitCode: 1 })
    const res = await BashTool.call({ command: 'do-something' }, { cwd, abortSignal: signal, sandbox, sandboxPolicy: wsWrite })
    expect(res.isError).toBe(true)
    expect(res.content).toContain(sandboxDenialMarker('workspace-write'))
    expect(res.content).toContain(escalationHintMarker('command'))
  })
  it('a failure NOT matching the signatures stays an ordinary error', async () => {
    const sandbox = fakeSandbox({ output: 'SyntaxError: unexpected token', exitCode: 1 })
    const res = await BashTool.call({ command: 'node broken.js' }, { cwd, abortSignal: signal, sandbox, sandboxPolicy: wsWrite })
    expect(res.isError).toBe(true)
    expect(res.content).not.toContain('[sandbox:')
  })
})

describe('scheduler escalation choreography (the one-call grant)', () => {
  const bashUse = (input: unknown) => [{ id: 't1', name: 'Bash', input }]

  it('a non-widening ask errors immediately and NEVER prompts the user', async () => {
    const perm = fakePerm('allow')
    const sandbox = fakeSandbox()
    const { blocks } = await run(
      bashUse({ command: 'touch x', sandbox_permissions: 'workspace-write', justification: 'x' }),
      { cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: wsWrite },
    )
    expect(resultText(blocks[0])).toContain('not strictly wider')
    expect(perm.request).not.toHaveBeenCalled()
    expect(sandbox.calls).toHaveLength(0)
  })

  it('an approved escalation runs the call ONCE under the widened policy, input stripped', async () => {
    const perm = fakePerm('allow')
    const sandbox = fakeSandbox()
    const { events, blocks } = await run(
      bashUse({ command: 'touch x.txt', sandbox_permissions: 'workspace-write', justification: 'create the file the task needs' }),
      { cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: readOnly },
    )
    expect(perm.request).toHaveBeenCalledTimes(1)
    const ask = events.find((e) => e.type === 'permission')
    expect(ask && 'detail' in ask ? ask.detail : '').toContain('Escalate sandbox to workspace-write')
    expect(sandbox.calls).toHaveLength(1)
    expect(sandbox.calls[0].command).toBe('touch x.txt')
    expect(sandbox.calls[0].opts?.policy?.mode).toBe('workspace-write') // the one-call grant reached exec
    expect(resultText(blocks[0])).not.toContain('[sandbox:') // no denial — the widened call succeeded
  })

  it('a denied escalation blocks the call and tells the model not to retry', async () => {
    const perm = fakePerm('deny')
    const sandbox = fakeSandbox()
    const { blocks } = await run(
      bashUse({ command: 'touch x', sandbox_permissions: 'workspace-write', justification: 'need it' }),
      { cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: readOnly },
    )
    expect(resultText(blocks[0])).toContain('rejected escalating')
    expect(sandbox.calls).toHaveLength(0)
  })

  it('fail-closed: no approval channel ⇒ no widening, the call never runs', async () => {
    const sandbox = fakeSandbox()
    const { blocks } = await run(
      bashUse({ command: 'touch x', sandbox_permissions: 'workspace-write', justification: 'need it' }),
      { cwd, abortSignal: signal, sandbox, sandboxPolicy: readOnly },
    )
    expect(resultText(blocks[0])).toContain('no approval channel is composed')
    expect(sandbox.calls).toHaveLength(0)
  })

  it('the widening lasts exactly one call — the next un-escalated call is fenced again', async () => {
    const perm = fakePerm('allow')
    const sandbox = fakeSandbox()
    const ctx: ToolContext = { cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: readOnly }
    await run(bashUse({ command: 'touch x.txt', sandbox_permissions: 'workspace-write', justification: 'create it' }), ctx)
    expect(sandbox.calls).toHaveLength(1)
    const { blocks } = await run(bashUse({ command: 'touch y.txt' }), ctx)
    expect(resultText(blocks[0])).toContain(sandboxDenialMarker('read-only'))
    expect(sandbox.calls).toHaveLength(1) // still one — the second call never ran
  })
})
