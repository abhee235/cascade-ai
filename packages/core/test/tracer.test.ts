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
        [textDelta('done'), done('end_turn')],
      ])
      const session = createSession({ cwd: dir, provider, model: 'fake', tracer, autoMemory: false })

      await drive(session, 'write note.txt', 'allow')

      const seq = events.map((e) => e.t)
      // The skeleton of any agent run, captured untruncated:
      expect(seq).toEqual([
        'submit',
        'model_request', // turn 0: the FULL request (messages/system/tools)
        'model_response', // turn 0: the model asked for Write
        'permission', // gate verdict
        'tool_call', // Write ran
        'tool_result',
        'model_request', // turn 1: model now sees the tool_result
        'model_response',
        'turn_done',
      ])

      // The model_request records the actual messages + advertised tools — the #1 debugging artifact.
      const req0 = events.find((e) => e.t === 'model_request') as Extract<TraceEvent, { t: 'model_request' }>
      expect(req0.tools).toContain('Write')
      expect(req0.messages[0]).toMatchObject({ role: 'user' })

      const perm = events.find((e) => e.t === 'permission') as Extract<TraceEvent, { t: 'permission' }>
      expect(perm).toMatchObject({ tool: 'Write', decision: 'allow' })

      const result = events.find((e) => e.t === 'tool_result') as Extract<TraceEvent, { t: 'tool_result' }>
      expect(result.ok).toBe(true)
      expect(typeof result.ms).toBe('number')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
