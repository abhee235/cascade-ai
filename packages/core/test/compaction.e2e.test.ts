import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { runAgentLoop } from '../src/agent/agentLoop'
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
      compact: { provider, model: 'fake', config: { window: 400, compactRatio: 0.8, keepRecentRatio: 0.25 } },
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
})
