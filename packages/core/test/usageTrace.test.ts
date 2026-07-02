// E1 (PLAN-eval) / ADR-040 — the eval analyzer reads token usage + compaction events from the trace.
// These tests drive the REAL agent loop with a capturing tracer and assert both signals land.

import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { runAgentLoop } from '../src/agent/agentLoop'
import { planCompaction } from '../src/context/compactionPlan'
import type { TraceEvent, Tracer } from '../src/observability/tracer'
import type { Message } from '../src/protocol'
import { createFakeProvider, textDelta, done } from './fakeProvider'

function capturingTracer(): Tracer & { events: TraceEvent[] } {
  const events: TraceEvent[] = []
  return { events, event: (e) => void events.push(e) }
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) {
    /* consume */
  }
}

describe('E1: usage + compaction land in the trace', () => {
  it('model_response carries the backend-reported usage from the done event', async () => {
    const provider = createFakeProvider([
      [textDelta('hi there'), done('end_turn', { inputTokens: 1234, outputTokens: 56 })],
    ])
    const tracer = capturingTracer()
    await drain(
      runAgentLoop([{ role: 'user', content: 'hello' }], {
        provider,
        model: 'fake',
        cwd: tmpdir(),
        signal: new AbortController().signal,
        tracer,
      }),
    )
    const resp = tracer.events.find((e) => e.t === 'model_response') as Extract<TraceEvent, { t: 'model_response' }>
    expect(resp.usage).toEqual({ inputTokens: 1234, outputTokens: 56 })
  })

  it('usage stays undefined when the backend does not report it', async () => {
    const provider = createFakeProvider([[textDelta('ok'), done('end_turn')]])
    const tracer = capturingTracer()
    await drain(
      runAgentLoop([{ role: 'user', content: 'hello' }], {
        provider,
        model: 'fake',
        cwd: tmpdir(),
        signal: new AbortController().signal,
        tracer,
      }),
    )
    const resp = tracer.events.find((e) => e.t === 'model_response') as Extract<TraceEvent, { t: 'model_response' }>
    expect(resp.usage).toBeUndefined()
  })

  it('a compaction emits a trace event with kind + before/after token estimates', async () => {
    // Long chatty history over a tiny 400-token window ⇒ the pre-turn compaction fires (same setup as
    // compaction.e2e); assert the TRACE side (the e2e test asserts the history side).
    const history: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}: ${'lorem ipsum dolor '.repeat(8)}`,
    }))
    const provider = createFakeProvider([
      [textDelta('[SUMMARY]')], // summarize side-query (provider.complete)
      [textDelta('answer'), done('end_turn')], // the actual turn
    ])
    const tracer = capturingTracer()
    await drain(
      runAgentLoop(history, {
        provider,
        model: 'fake',
        cwd: tmpdir(),
        signal: new AbortController().signal,
        tracer,
        compact: { provider, model: 'fake', plan: planCompaction({ window: 400 }) },
      }),
    )
    const comp = tracer.events.find((e) => e.t === 'compaction') as Extract<TraceEvent, { t: 'compaction' }>
    expect(comp).toBeTruthy()
    expect(comp.kind).toBe('summarized')
    expect(comp.forced).toBe(false)
    expect(comp.tokensAfter).toBeLessThan(comp.tokensBefore) // it actually reclaimed tokens
  })
})
