import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { runAgentLoop } from '../src/agent/agentLoop'
import { planCompaction } from '../src/context/compactionPlan'
import { createFakeProvider, textDelta, done } from './fakeProvider'
import type { ActivityEvent, Message } from '../src/protocol'

// End-to-end through the REAL loop + compactor: a long history collapses before the next model call.
describe('compaction e2e (through runAgentLoop)', () => {
  it('collapses a long history into [summary, ...recent] and emits a compacted event', async () => {
    // 40 chatty messages — well past a tiny 400-token window.
    const history: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}: ${'lorem ipsum dolor '.repeat(8)}`,
    }))
    const before = history.length

    const provider = createFakeProvider([
      [textDelta('[STRUCTURED SUMMARY of the older turns]')], // Phase B summary (provider.complete)
      [textDelta('Answer after compaction.'), done('end_turn')], // the actual turn (provider.stream)
    ])

    const events: ActivityEvent[] = []
    for await (const e of runAgentLoop(history, {
      provider,
      model: 'fake',
      cwd: tmpdir(),
      signal: new AbortController().signal,
      compact: { provider, model: 'fake', plan: planCompaction({ window: 400 }) },
    })) {
      events.push(e)
    }

    const compacted = events.find((e) => e.type === 'compacted') as Extract<ActivityEvent, { type: 'compacted' }>
    // Show the collapse so a human running the suite can see it.
    console.log(`\n[compaction e2e] messages: ${before} → ${history.length}  (kind: ${compacted?.kind})`)
    console.log(`[compaction e2e] first message now: ${JSON.stringify(history[0].content).slice(0, 70)}…\n`)

    expect(compacted).toBeTruthy()
    expect(compacted.kind).toBe('summarized')
    expect(history.length).toBeLessThan(before) // history was spliced in place
    expect(history[0].content).toContain('STRUCTURED SUMMARY') // older turns replaced by the summary
    expect(history.some((m) => JSON.stringify(m.content).includes('message 39'))).toBe(true) // recent kept verbatim
    expect(history.some((m) => JSON.stringify(m.content).includes('message 5'))).toBe(false) // old turn was summarized away
  })

  // The UI meter's data source. Cumulative token spend is the number that's easy to surface and it misleads:
  // a stateless API re-sends the whole conversation each call, so the total climbs forever while the window
  // may be barely touched. Only OCCUPANCY — one prompt vs the window — decides whether history gets rewritten.
  it('reports context occupancy after each model call, against the window compaction gates on', async () => {
    const provider = createFakeProvider([[textDelta('hi'), done('end_turn')]])
    const plan = planCompaction({ window: 131072 })
    const events: ActivityEvent[] = []
    for await (const e of runAgentLoop([{ role: 'user', content: 'hello' }], {
      provider,
      model: 'fake',
      cwd: tmpdir(),
      signal: new AbortController().signal,
      compact: { provider, model: 'fake', plan },
    })) {
      events.push(e)
    }

    const ctx = events.find((e) => e.type === 'context') as Extract<ActivityEvent, { type: 'context' }>
    expect(ctx).toBeTruthy()
    expect(ctx.window).toBe(131072)
    expect(ctx.auto).toBe(plan.auto) // the meter colours by the REAL trigger, not a round number
    expect(ctx.used).toBeGreaterThan(0)
    expect(ctx.used).toBeLessThan(ctx.window) // a short turn is nowhere near full — the whole point
  })
})
