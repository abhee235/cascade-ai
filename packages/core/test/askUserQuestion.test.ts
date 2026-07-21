import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../src/agent/agentLoop'
import { createSession } from '../src/session'
import { AskUserQuestionTool } from '../src/tools/builtins/AskUserQuestion'
import { defaultRegistry } from '../src/tools/toolRegistry'
import { createFakeProvider, toolUse, textDelta, done } from './fakeProvider'
import type { ActivityEvent, Answers, Message } from '../src/protocol'
import type { AskController } from '../src/tools/Tool'

const cwd = mkdtempSync(join(tmpdir(), 'ask-'))
const QUESTION = {
  question: 'Which database?',
  header: 'DB',
  options: [
    { label: 'Postgres', description: 'Relational, robust' },
    { label: 'SQLite', description: 'Zero-config, file-based' },
  ],
}

describe('AskUserQuestion — the loop parks on a `question` event and resumes with the answer (ADR-043)', () => {
  it('yields `question`, BLOCKS on ctx.ask, then feeds the answer back as the tool_result', async () => {
    const provider = createFakeProvider([
      [toolUse('q1', 'AskUserQuestion', { questions: [QUESTION] }), done('tool_use')],
      [textDelta('Great — using Postgres.'), done('end_turn')],
    ])
    // A deferred answer we resolve ONLY after we've seen the question event — proves the loop actually waits.
    let resolveAnswer!: (a: Answers) => void
    const answer = new Promise<Answers>((r) => (resolveAnswer = r))
    let requestedId: string | undefined
    let requestedBeforeQuestion = false
    let sawQuestion = false
    const ask: AskController = {
      request: (id) => {
        requestedId = id
        // RACE FIX (scheduler): request() must run BEFORE the question is yielded, so the resolver is
        // registered when a consumer answers synchronously on the event (else the answer is dropped → hang).
        if (!sawQuestion) requestedBeforeQuestion = true
        return answer
      },
    }

    const messages: Message[] = [{ role: 'user', content: 'set up the db' }]
    const events: ActivityEvent[] = []
    for await (const ev of runAgentLoop(messages, { provider, model: 'fake', cwd, signal: new AbortController().signal, ask, maxTurns: 5 })) {
      events.push(ev)
      if (ev.type === 'question') {
        sawQuestion = true
        expect(ev.questions[0].question).toBe('Which database?')
        resolveAnswer({ 'Which database?': 'Postgres' }) // the "user" answers now → loop wakes
      }
    }

    expect(sawQuestion).toBe(true)
    expect(requestedId).toBe('q1') // scheduler awaited ctx.ask.request with the tool-use id
    expect(requestedBeforeQuestion).toBe(true) // resolver registered BEFORE the event (closes the sync-answer race)
    // The answer became the tool_result the model saw next turn:
    const toolResult = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result' && b.tool_use_id === 'q1')
    expect((toolResult as any)?.content).toMatch(/Postgres/)
    // And the model's final answer reflects it.
    const last = messages[messages.length - 1]
    expect(Array.isArray(last.content) && last.content.some((b) => b.type === 'text' && /Postgres/.test(b.text))).toBe(true)
  })

  it('no interactive channel (headless) → the tool returns a clear error, loop does NOT hang', async () => {
    const provider = createFakeProvider([
      [toolUse('q1', 'AskUserQuestion', { questions: [QUESTION] }), done('tool_use')],
      [textDelta('Defaulting to Postgres.'), done('end_turn')],
    ])
    const messages: Message[] = [{ role: 'user', content: 'x' }]
    const events: ActivityEvent[] = []
    for await (const ev of runAgentLoop(messages, { provider, model: 'fake', cwd, signal: new AbortController().signal, maxTurns: 5 })) {
      events.push(ev) // no `ask` → the tool's call() runs and returns the no-channel error
    }
    expect(events.some((e) => e.type === 'question')).toBe(false)
    const toolResult = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result' && b.tool_use_id === 'q1')
    expect((toolResult as any)?.content).toMatch(/No interactive channel/)
    expect((toolResult as any)?.isError).toBe(true)
  })

  it('abort() with a PARKED question unhangs the loop (Stop pressed while the card is up)', async () => {
    // session.abort() drained pending PERMISSIONS but not pending ANSWERS — Stop during a question parked the
    // loop forever (in every frontend). Now it resolves the parked ask with no answers so the turn unwinds.
    const dir = mkdtempSync(join(tmpdir(), 'ask-abort-'))
    const provider = createFakeProvider([
      [toolUse('q1', 'AskUserQuestion', { questions: [QUESTION] }), done('tool_use')],
      [textDelta('unwound'), done('end_turn')],
    ])
    const session = createSession({ cwd: dir, provider, model: 'fake', autoMemory: false, verifyGate: false })
    const events: ActivityEvent[] = []
    for await (const ev of session.submit('pick a db')) {
      events.push(ev)
      if (ev.type === 'question') session.abort() // the Stop button, while the loop is parked on the answer
    }
    // Reaching here at all is the fix — without it, the for-await never completes (test times out).
    expect(events.some((e) => e.type === 'question')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('tier-sized description + registered + uniqueness validation', () => {
    expect(defaultRegistry.find('AskUserQuestion')).toBeTruthy()
    const at = (tier: 'minimal' | 'lean' | 'full') => defaultRegistry.schemas(tier).find((s) => s.name === 'AskUserQuestion')!.description
    expect(at('minimal').length).toBeLessThan(at('full').length)
    for (const tier of ['minimal', 'lean', 'full'] as const) expect(at(tier)).toMatch(/Other/) // convention kept at every tier
    // uniqueness refine: duplicate option labels rejected
    const bad = (AskUserQuestionTool.inputSchema as any).safeParse({ questions: [{ question: 'q?', header: 'h', options: [{ label: 'A', description: 'x' }, { label: 'A', description: 'y' }] }] })
    expect(bad.success).toBe(false)
  })
})

rmSync(cwd, { recursive: true, force: true })
