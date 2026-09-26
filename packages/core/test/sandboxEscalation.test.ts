// sandboxEscalation.test.ts — ADR-070 step 2 + ADR-082: denial markers, GROUNDED escalation choreography,
// one-call grants. An escalation prompt is reachable only for a strictly wider ask AFTER a real denial this
// session; every other well-formed ask is a NO-OP (the call runs under the current policy, with a note).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escalationHintMarker, parseEscalation, sandboxDenialMarker, withoutEscalationFields } from '../src/sandbox/escalation'
import { scheduleTools } from '../src/tools/scheduler'
import { schemaOf } from '../src/tools/toolRegistry'
import { BashTool } from '../src/tools/builtins/Bash'
import { ReadTool } from '../src/tools/builtins/Read'
import { WriteTool } from '../src/tools/builtins/Write'
import type { ToolContext } from '../src/tools/Tool'
import type { ActivityEvent, ContentBlock } from '../src/protocol'
import type { ExecOptions, Sandbox } from '../src/sandbox/sandbox'
import type { SandboxPolicy } from '../src/sandbox/policy'

const cwd = mkdtempSync(join(tmpdir(), 'sbxesc-'))
const signal = new AbortController().signal

const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace' }
const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/workspace' }
const denied = { denialSeen: true }

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
const bashUse = (id: string, input: unknown) => [{ id, name: 'Bash', input }]

/** Ground a session: one un-escalated mutating call under read-only produces the real denial that makes a
 *  later strictly-wider ask a genuine escalation. Returns the same ctx, now carrying sandboxDenialSeen. */
async function primeDenial(ctx: ToolContext): Promise<ToolContext> {
  const { blocks } = await run(bashUse('prime', { command: 'touch primed.txt' }), ctx)
  expect(resultText(blocks[0])).toContain(sandboxDenialMarker('read-only'))
  expect(ctx.sandboxDenialSeen).toBe(true)
  return ctx
}

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

describe('parseEscalation — malformed pairings rejected; everything else is a no-op unless grounded + wider', () => {
  it('no escalation fields → undefined (the common case costs nothing)', () => {
    expect(parseEscalation({ command: 'ls' }, wsWrite)).toBeUndefined()
  })
  it('sandbox_permissions without justification', () => {
    expect(parseEscalation({ sandbox_permissions: 'danger-full-access' }, wsWrite, denied)).toEqual({
      error: 'invalid escalation: sandbox_permissions requires a justification',
    })
  })
  it('justification without sandbox_permissions', () => {
    expect(parseEscalation({ justification: 'because' }, wsWrite, denied)).toEqual({
      error: 'invalid escalation: justification is only valid together with sandbox_permissions',
    })
  })
  it('blank justification', () => {
    expect(parseEscalation({ sandbox_permissions: 'danger-full-access', justification: '  ' }, wsWrite, denied)).toEqual({
      error: 'invalid justification: expected a non-empty sentence',
    })
  })
  it('no confined policy active → no-op (the call runs unrestricted anyway)', () => {
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'x' }, undefined, denied)).toMatchObject({
      noop: expect.stringContaining('no confined sandbox policy'),
    })
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'x' }, { mode: 'danger-full-access', workspaceRoot: '/w' }, denied)).toMatchObject({
      noop: expect.stringContaining('no confined sandbox policy'),
    })
  })
  it('the mode already held → no-op, not an error (the measured luna case)', () => {
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'x' }, wsWrite, denied)).toMatchObject({
      noop: expect.stringContaining('already runs under "workspace-write"'),
    })
  })
  it('a strictly wider ask with NO prior denial → no-op that teaches the grounding rule', () => {
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'need to write' }, readOnly)).toMatchObject({
      noop: expect.stringContaining('no sandbox denial has occurred'),
    })
  })
  it('a strictly wider ask AFTER a denial is the one valid ask', () => {
    expect(parseEscalation({ sandbox_permissions: 'workspace-write', justification: 'need to write' }, readOnly, denied)).toEqual({
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

describe('scheduler — no-op asks run the call; only grounded + wider asks reach the user (ADR-082)', () => {
  it('the measured luna sequence: a pre-emptive same-mode ask on a Write RUNS the write, never prompts, and the note teaches the rule', async () => {
    const perm = fakePerm('allow')
    const ctx: ToolContext = { cwd, abortSignal: signal, permission: perm, sandboxPolicy: wsWrite }
    const { blocks } = await run(
      [{ id: 'w1', name: 'Write', input: { file_path: 'PLAN.md', content: '# plan', sandbox_permissions: 'workspace-write', justification: 'Create the required root PLAN.md contract for the builder.' } }],
      ctx,
    )
    expect(perm.request).not.toHaveBeenCalled()
    expect(existsSync(join(cwd, 'PLAN.md'))).toBe(true) // the call ran — the fields were a no-op, not a failure
    expect(readFileSync(join(cwd, 'PLAN.md'), 'utf8')).toBe('# plan')
    expect(resultText(blocks[0])).toContain('sandbox_permissions ignored')
    expect(resultText(blocks[0])).toContain('already runs under "workspace-write"')
  })

  it('an UNSOLICITED strictly-wider ask (no denial yet) is a no-op: the call runs under the current policy and no one is prompted', async () => {
    const perm = fakePerm('allow')
    const sandbox = fakeSandbox()
    const ctx: ToolContext = { cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: readOnly }
    const { blocks } = await run(bashUse('t0', { command: 'echo hi', sandbox_permissions: 'danger-full-access', justification: 'x' }), ctx)
    expect(perm.request).not.toHaveBeenCalled()
    expect(sandbox.calls).toHaveLength(1)
    expect(sandbox.calls[0].opts?.policy?.mode).toBe('read-only') // NOT widened
    expect(resultText(blocks[0])).toContain('no sandbox denial has occurred')
  })

  it('a same-mode ask errors on nothing and runs the command under the current policy', async () => {
    const perm = fakePerm('allow')
    const sandbox = fakeSandbox()
    const { blocks } = await run(
      bashUse('t1', { command: 'touch x', sandbox_permissions: 'workspace-write', justification: 'x' }),
      { cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: wsWrite },
    )
    expect(perm.request).not.toHaveBeenCalled()
    expect(sandbox.calls).toHaveLength(1)
    expect(sandbox.calls[0].command).toBe('touch x')
    expect(resultText(blocks[0])).toContain('sandbox_permissions ignored')
  })

  it('a grounded, approved escalation runs the call ONCE under the widened policy, input stripped', async () => {
    const perm = fakePerm('allow')
    const sandbox = fakeSandbox()
    const ctx = await primeDenial({ cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: readOnly })
    const { events, blocks } = await run(
      bashUse('t2', { command: 'touch x.txt', sandbox_permissions: 'workspace-write', justification: 'create the file the task needs' }),
      ctx,
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
    const ctx = await primeDenial({ cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: readOnly })
    const { blocks } = await run(bashUse('t3', { command: 'touch x', sandbox_permissions: 'workspace-write', justification: 'need it' }), ctx)
    expect(resultText(blocks[0])).toContain('rejected escalating')
    expect(sandbox.calls).toHaveLength(0)
  })

  it('fail-closed: no approval channel ⇒ no widening, the call never runs', async () => {
    const sandbox = fakeSandbox()
    const ctx = await primeDenial({ cwd, abortSignal: signal, sandbox, sandboxPolicy: readOnly })
    const { blocks } = await run(bashUse('t4', { command: 'touch x', sandbox_permissions: 'workspace-write', justification: 'need it' }), ctx)
    expect(resultText(blocks[0])).toContain('no approval channel is composed')
    expect(sandbox.calls).toHaveLength(0)
  })

  it('the widening lasts exactly one call — the next un-escalated call is fenced again', async () => {
    const perm = fakePerm('allow')
    const sandbox = fakeSandbox()
    const ctx = await primeDenial({ cwd, abortSignal: signal, permission: perm, sandbox, sandboxPolicy: readOnly })
    await run(bashUse('t5', { command: 'touch x.txt', sandbox_permissions: 'workspace-write', justification: 'create it' }), ctx)
    expect(sandbox.calls).toHaveLength(1)
    const { blocks } = await run(bashUse('t6', { command: 'touch y.txt' }), ctx)
    expect(resultText(blocks[0])).toContain(sandboxDenialMarker('read-only'))
    expect(sandbox.calls).toHaveLength(1) // still one — the second call never ran
  })
})

describe('withoutEscalationFields — the lever is not SHOWN until a denial happens (ADR-082)', () => {
  it('the real Bash/Write schemas carry the fields, so hiding them is not a no-op', () => {
    // Guards the premise: if the fields ever stop being advertised by default, this test fails loudly
    // rather than letting the gating quietly protect nothing.
    for (const tool of [BashTool, WriteTool]) {
      const props = (schemaOf(tool).properties ?? {}) as Record<string, unknown>
      expect(Object.keys(props)).toContain('sandbox_permissions')
      expect(Object.keys(props)).toContain('justification')
    }
  })

  it('strips both fields while leaving every other property intact', () => {
    const [bash] = withoutEscalationFields([{ name: 'Bash', description: '', parameters: schemaOf(BashTool) }])
    const props = (bash!.parameters.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(props)).not.toContain('sandbox_permissions')
    expect(Object.keys(props)).not.toContain('justification')
    expect(Object.keys(props)).toContain('command') // the tool itself is untouched
  })

  it('never mutates the caller’s schema (the registry hands out shared objects)', () => {
    const parameters = schemaOf(BashTool)
    withoutEscalationFields([{ name: 'Bash', description: '', parameters }])
    expect(Object.keys(parameters.properties as Record<string, unknown>)).toContain('sandbox_permissions')
  })

  it('returns a schema with no escalation fields UNCHANGED by identity (costs nothing per turn)', () => {
    const schema = { name: 'Read', description: '', parameters: schemaOf(ReadTool) }
    expect(withoutEscalationFields([schema])[0]).toBe(schema)
  })
})
