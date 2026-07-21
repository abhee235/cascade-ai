import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../src/agent/agentLoop'
import { createFakeProvider, toolUse, textDelta, done } from './fakeProvider'
import type { PermissionController, PermissionState } from '../src/permissions/gate'
import type { AskController } from '../src/tools/Tool'
import type { Answers, ContentBlock, Message } from '../src/protocol'

const trOf = (messages: Message[], id: string): any =>
  messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as ContentBlock[]) : [])).find((b) => b.type === 'tool_result' && b.tool_use_id === id)

function run(scripts: Parameters<typeof createFakeProvider>[0], onQuestion: (q: string) => Answers, initialMode: PermissionState['mode'] = 'acceptEdits') {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-'))
  const state: PermissionState = { mode: initialMode, allow: new Set(), deny: new Set() } // writes auto-allow when NOT in plan mode
  const permission: PermissionController = { state, request: () => new Promise(() => {}) } // never called (plan denies, acceptEdits/bypass allow)
  let resolveAnswer!: (a: Answers) => void
  const answer = new Promise<Answers>((r) => (resolveAnswer = r))
  const ask: AskController = { request: () => answer }
  const messages: Message[] = [{ role: 'user', content: 'add a feature' }]
  const provider = createFakeProvider(scripts)
  return { cwd, state, messages, run: async () => {
    for await (const ev of runAgentLoop(messages, { provider, model: 'fake', cwd, signal: new AbortController().signal, permission, ask, maxTurns: 8 })) {
      if (ev.type === 'question') resolveAnswer(onQuestion(ev.questions[0].question))
    }
  } }
}

describe('Plan mode flow — enter → writes blocked → exit → approve → unlock (ADR-044)', () => {
  it('a write is BLOCKED in plan mode, then UNLOCKS after the plan is approved', async () => {
    const t = run(
      [
        [toolUse('e', 'EnterPlanMode', {}), done('tool_use')],
        [toolUse('w1', 'Write', { file_path: 'blocked.txt', content: 'x' }), done('tool_use')], // denied in plan mode
        [toolUse('x', 'ExitPlanMode', { plan: '1. create allowed.txt with the content' }), done('tool_use')],
        [toolUse('w2', 'Write', { file_path: 'allowed.txt', content: 'y' }), done('tool_use')], // now unlocked
        [textDelta('done'), done('end_turn')],
      ],
      (q) => {
        expect(q).toMatch(/create allowed\.txt/) // the plan is shown to the user
        return { [q]: 'Approve' }
      },
    )
    await t.run()

    expect(existsSync(join(t.cwd, 'blocked.txt'))).toBe(false) // write during plan mode never happened
    expect(existsSync(join(t.cwd, 'allowed.txt'))).toBe(true) // write after approval succeeded
    expect(t.state.mode).toBe('acceptEdits') // restored to the PRIOR mode, not left in plan/default

    expect(trOf(t.messages, 'w1')?.isError).toBe(true)
    expect(trOf(t.messages, 'w1')?.content).toMatch(/PLAN MODE/) // plan-specific message, not "user declined"
    expect(trOf(t.messages, 'x')?.content).toMatch(/APPROVED/)
    rmSync(t.cwd, { recursive: true, force: true })
  })

  it('Revise keeps the session in plan mode (writes stay blocked)', async () => {
    const t = run(
      [
        [toolUse('e', 'EnterPlanMode', {}), done('tool_use')],
        [toolUse('x', 'ExitPlanMode', { plan: '1. do the thing' }), done('tool_use')],
        [toolUse('w', 'Write', { file_path: 'nope.txt', content: 'z' }), done('tool_use')], // still blocked after Revise
        [textDelta('revising'), done('end_turn')],
      ],
      (q) => ({ [q]: 'Revise' }),
    )
    await t.run()

    expect(t.state.mode).toBe('plan') // NOT approved → still in plan mode
    expect(existsSync(join(t.cwd, 'nope.txt'))).toBe(false)
    expect(trOf(t.messages, 'x')?.isError).toBe(true)
    expect(trOf(t.messages, 'x')?.content).toMatch(/did NOT approve/)
    rmSync(t.cwd, { recursive: true, force: true })
  })

  // Edge case (the web quirk): a weak model calls ExitPlanMode WITHOUT a preceding EnterPlanMode, so there's no
  // saved priorMode. Approving must NOT clobber the session's mode to 'default' — the web runs 'bypass' and has
  // no permission UI, so a forced 'default' would make the follow-up write hang. Approval must leave 'bypass'.
  it('Approve does NOT downgrade bypass→default when ExitPlanMode is called without EnterPlanMode', async () => {
    const t = run(
      [
        [toolUse('x', 'ExitPlanMode', { plan: '1. create out.txt with the content' }), done('tool_use')], // no EnterPlanMode first
        [toolUse('w', 'Write', { file_path: 'out.txt', content: 'ok' }), done('tool_use')], // must still write (bypass)
        [textDelta('done'), done('end_turn')],
      ],
      (q) => ({ [q]: 'Approve' }),
      'bypass', // the web's mode
    )
    await t.run()

    expect(t.state.mode).toBe('bypass') // stayed bypass — NOT forced to 'default'
    expect(existsSync(join(t.cwd, 'out.txt'))).toBe(true) // the post-approval write still succeeded
    expect(trOf(t.messages, 'x')?.content).toMatch(/APPROVED/)
    rmSync(t.cwd, { recursive: true, force: true })
  })

  // Regression (builder-graduate on gpt-5.6-luna hung here): a SYNCHRONOUS responder + the SESSION's
  // register-on-request ask semantics deadlocked ExitPlanMode. The scheduler yielded the `question` BEFORE
  // ctx.ask.request() registered the resolver, so an answer delivered synchronously (the headless eval's
  // auto-responder) was dropped, and the later request() awaited forever. The mock ask in the tests above
  // hid it (pre-created promise, resolver captured up front). This uses the real register-on-request shape.
  it('a SYNCHRONOUS responder does not deadlock ExitPlanMode (register-on-request ask)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'plan-'))
    const state: PermissionState = { mode: 'bypass', allow: new Set(), deny: new Set() }
    const permission: PermissionController = { state, request: () => new Promise(() => {}) }
    // The session's ask: the resolver is registered INSIDE request() (not before) — the shape that races.
    const pending = new Map<string, (a: Answers) => void>()
    const ask: AskController = { request: (id: string) => new Promise<Answers>((res) => pending.set(id, res)) }
    const respond = (id: string, a: Answers) => {
      const r = pending.get(id)
      if (r) {
        pending.delete(id)
        r(a)
      }
    }
    const provider = createFakeProvider([
      [toolUse('x', 'ExitPlanMode', { plan: '1. do the thing' }), done('tool_use')],
      [textDelta('done'), done('end_turn')],
    ])
    const messages: Message[] = [{ role: 'user', content: 'plan it' }]
    const drive = (async () => {
      for await (const ev of runAgentLoop(messages, { provider, model: 'fake', cwd, signal: new AbortController().signal, permission, ask, maxTurns: 8 })) {
        if (ev.type === 'question') respond(ev.id, { [ev.questions[0].question]: 'Approve' }) // answer IMMEDIATELY
      }
    })()
    await Promise.race([drive, new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: ExitPlanMode never resolved')), 3000))])
    expect(trOf(messages, 'x')?.content).toMatch(/APPROVED/) // the round-trip completed instead of hanging
    rmSync(cwd, { recursive: true, force: true })
  })
})
