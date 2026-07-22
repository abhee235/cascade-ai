import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, type CascadeSession } from '../src/session'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'
import type { Tracer, TraceEvent } from '../src/observability/tracer'

// Drive a turn, auto-answering permission prompts (see permission.test for the .next()-then-respond ordering).
async function drive(session: CascadeSession, text: string, decision: 'allow' | 'allow-always' | 'deny') {
  const gen = session.submit(text)[Symbol.asyncIterator]()
  let r = await gen.next()
  while (!r.done) {
    if (r.value.type === 'permission') {
      const next = gen.next()
      session.respondPermission(r.value.id, decision)
      r = await next
      continue
    }
    r = await gen.next()
  }
}

describe('tracer — forensic event stream', () => {
  it('captures the full run: submit → model_request/response → permission → tool_call/result → turn_done', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-trace-'))
    try {
      const events: TraceEvent[] = []
      const tracer: Tracer = { event: (e) => events.push(e) }
      const provider = createFakeProvider([
        [toolUse('w1', 'Write', { file_path: 'note.txt', content: 'hi' }), done('tool_use')],
        [textDelta('done'), done('end_turn')], // premature "done" — the ADR-049 gate objects (edit, no verification)
        [textDelta('no tests exist here'), done('end_turn')], // post-nudge answer — accepted
      ])
      const session = createSession({ cwd: dir, provider, model: 'fake', tracer, autoMemory: false })

      await drive(session, 'write note.txt', 'allow')

      const seq = events.map((e) => e.t)
      // The skeleton of any agent run, captured untruncated (incl. the ADR-049 verification gate firing
      // on an unverified edit — files changed, no test command ran):
      expect(seq).toEqual([
        'submit',
        'model_request', // turn 0: the FULL request (messages/system/tools)
        'model_response', // turn 0: the model asked for Write
        'permission', // gate verdict
        'tool_call', // Write ran
        'tool_result',
        'model_request', // turn 1: model now sees the tool_result
        'model_response', // "done" — but nothing verified the edit…
        'verify_gate', // …so the ADR-049 gate injects ONE nudge turn
        'model_request', // turn 2: model sees the nudge
        'model_response',
        'turn_done',
      ])

      // The model_request records the actual messages + advertised tools — the #1 debugging artifact.
      const req0 = events.find((e) => e.t === 'model_request') as Extract<TraceEvent, { t: 'model_request' }>
      expect(req0.tools).toContain('Write')
      expect(req0.messages[0]).toMatchObject({ role: 'user' })
      // …and WHO answered. Without this, "was my selected model actually used?" is unanswerable from the
      // trace alone, and a mid-session model switch leaves no evidence at all.
      expect(req0).toMatchObject({ provider: 'fake', model: expect.any(String) })

      const perm = events.find((e) => e.t === 'permission') as Extract<TraceEvent, { t: 'permission' }>
      expect(perm).toMatchObject({ tool: 'Write', decision: 'allow' })

      const result = events.find((e) => e.t === 'tool_result') as Extract<TraceEvent, { t: 'tool_result' }>
      expect(result.ok).toBe(true)
      expect(typeof result.ms).toBe('number')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A turn MUST be terminated on every path. `turn_done` is emitted where the loop returns normally, but an
  // abort unwinds straight past that — leaving the JSONL with no terminator (forensics can't tell "finished"
  // from "died": measured on a killed build) and any span-based exporter with an open root, which is never
  // exported at all. The session guarantees exactly one terminator.
  it('a turn that DIES mid-flight still emits exactly one turn_done, last', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-trace-died-'))
    try {
      const events: TraceEvent[] = []
      const tracer: Tracer = { event: (e) => void events.push(e) }
      // The backend blows up rather than answering — the loop unwinds by THROWING, so it never reaches the
      // `turn_done` on its normal return path. Only the session's finally can terminate this turn.
      const provider = {
        id: 'fake',
        async complete() {
          return { text: '' }
        },
        // eslint-disable-next-line require-yield
        async *stream(): AsyncIterable<never> {
          throw new Error('backend exploded')
        },
      } as unknown as Parameters<typeof createSession>[0]['provider']
      const session = createSession({ cwd: dir, provider, model: 'fake', tracer })

      for await (const _ of session.submit('go')) {
        /* drain — the session converts the throw into an error message + turnDone */
      }

      const terminators = events.filter((e) => e.t === 'turn_done')
      expect(terminators).toHaveLength(1) // was ZERO before: the trace just stopped, indistinguishable from a hang
      expect(events.some((e) => e.t === 'error')).toBe(true) // …and it followed the failure, not replaced it
      expect(events[events.length - 1]!.t).toBe('turn_done') // a terminator must actually terminate the file
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
