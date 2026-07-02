import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  olderBoundary,
  turnAlignedBoundary,
  maskObservations,
  compactIfNeeded,
  type CompactionPlan,
} from '../src/context/compactor'
import { createFakeProvider, textDelta } from './fakeProvider'
import type { ContentBlock, Message } from '../src/protocol'

/** Every tool_result in `messages` must have a matching tool_use somewhere before it — otherwise the sequence
 *  is invalid (an orphaned tool result 400s on strict hosted APIs such as OpenAI). Returns the orphaned ids (empty = valid). */
function orphanedToolResults(messages: Message[]): string[] {
  const useIds = new Set<string>()
  const orphans: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'tool_use') useIds.add(b.id)
      else if (b.type === 'tool_result' && !useIds.has(b.tool_use_id)) orphans.push(b.tool_use_id)
    }
  }
  return orphans
}

// A tiny synthetic plan for the compactIfNeeded tests: compact at 80 tok, keep 25 tok recent.
// (Real sizing is covered by compactionPlan.test.ts.)
const plan: CompactionPlan = {
  window: 100,
  effectiveWindow: 100,
  warn: 60,
  auto: 80,
  hard: 97,
  keepRecentTokens: 25,
  toolResultMaxChars: 2000,
  layers: new Set(['mask', 'summarize']),
  mode: 'layered',
  tier: 'full',
}

describe('compactor — helpers', () => {
  it('estimateTokens ~ chars/4', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(40) }])).toBe(10)
  })

  it('maskObservations masks large tool_results in the OLDER region only', () => {
    const big = 'A'.repeat(5000)
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: big }] }, // older (idx 0)
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: big }] }, // recent (idx 1)
    ]
    const out = maskObservations(msgs, 1) // olderCount = 1
    expect((out[0].content as any)[0].content).toMatch(/output masked/)
    expect((out[1].content as any)[0].content).toBe(big) // recent untouched
  })

  it('olderBoundary splits [older | recent] by the keep-recent budget', () => {
    const msgs: Message[] = Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(40) })) // 10 tok each
    expect(olderBoundary(msgs, 25)).toBe(3) // keeps last 2 (20 tok ≤ 25); a 3rd would overflow
  })

  it('turnAlignedBoundary walks a summarize split back to the nearest assistant (never orphans a tool_result)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q' }, // 0
      { role: 'assistant', content: [{ type: 'tool_use', id: 'A', name: 'Read', input: {} }] }, // 1
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'A', content: 'r' }] }, // 2
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, // 3
    ]
    expect(turnAlignedBoundary(msgs, 2)).toBe(1) // raw split @2 = user(tool_result) → back to the assistant @1
    expect(turnAlignedBoundary(msgs, 3)).toBe(3) // already an assistant → unchanged
    expect(turnAlignedBoundary(msgs, 1)).toBe(1) // already an assistant → unchanged
    // Degenerate all-user history (no assistant, so no tool pairs to orphan) → keep the raw split.
    expect(turnAlignedBoundary([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], 1)).toBe(1)
  })
})

describe('compactor — compactIfNeeded (plan-driven, ADR-039)', () => {
  it('under threshold ⇒ no change', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const provider = createFakeProvider([])
    const { kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan })
    expect(kind).toBe('none')
  })

  it('Layer A: masking large old tool output is enough ⇒ kind "masked", no LLM call', async () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'A'.repeat(4000) }] }, // ~1000 tok, older
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
    ]
    const provider = createFakeProvider([]) // summarize must NOT be called
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan })
    expect(kind).toBe('masked')
    expect((messages[0].content as any)[0].content).toMatch(/output masked/)
    expect(provider.calls.length).toBe(0)
  })

  it('Layer B: summarizes the older half into one message, keeps recent verbatim', async () => {
    const older: Message[] = Array.from({ length: 7 }, (_, i) => ({ role: 'user', content: `old message ${i} ${'x'.repeat(36)}` }))
    const recent: Message[] = [
      { role: 'user', content: `recent ${'y'.repeat(36)}` },
      { role: 'assistant', content: [{ type: 'text', text: `reply ${'z'.repeat(36)}` }] },
      { role: 'user', content: `latest ${'w'.repeat(36)}` },
    ]
    const provider = createFakeProvider([[textDelta('STRUCTURED SUMMARY OF OLDER')]])
    const discarded: Message[][] = []
    const { messages, kind } = await compactIfNeeded([...older, ...recent], {
      provider,
      model: 'fake',
      plan,
      onDiscard: async (o) => void discarded.push(o),
    })
    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('STRUCTURED SUMMARY OF OLDER') // summary replaces older
    expect(messages.length).toBeLessThan(older.length + recent.length) // history shrank
    expect(messages[messages.length - 1].content).toContain('latest') // most-recent message kept verbatim
    expect(discarded[0].length).toBeGreaterThan(0) // coupled-curation hook saw the older messages
  })

  it('summarize never orphans a tool_result: recent starts on an assistant, pairs stay intact', async () => {
    // Boundary would naturally land on a user(tool_result) whose assistant(tool_use) is in the summarized older
    // region — the exact orphan case. After the fix, `recent` must start on the assistant so the pair survives.
    const big = 'x'.repeat(40) // ~10 tok each, so the ~25-tok recent budget lands the raw split on @4
    const msgs: Message[] = [
      { role: 'user', content: `start ${big}` }, // 0 older
      { role: 'assistant', content: [{ type: 'text', text: `reading ${big}` }, { type: 'tool_use', id: 'A', name: 'Read', input: { file_path: 'a.ts' } }] }, // 1
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'A', content: `contents ${big}` }] }, // 2
      { role: 'assistant', content: [{ type: 'text', text: `editing ${big}` }, { type: 'tool_use', id: 'B', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] }, // 3 — must survive as recent[1]
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'B', content: `edited ${big}` }] }, // 4 — the raw boundary (orphan if unfixed)
      { role: 'assistant', content: [{ type: 'text', text: `done ${big}` }] }, // 5
    ]
    const provider = createFakeProvider([[textDelta('SUMMARY OF OLDER')]])
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan }, { force: true })

    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('SUMMARY OF OLDER') // older → one user summary
    expect(messages[1].role).toBe('assistant') // recent starts on an assistant (turn-aligned), not a tool_result
    expect(orphanedToolResults(messages)).toEqual([]) // and no tool_result is left without its tool_use
  })

  it('force: compacts even under the threshold (reactive overflow path)', async () => {
    // Well under auto=80, but force should still summarize the older half.
    const msgs: Message[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'user' as const, content: `old ${i} ${'x'.repeat(36)}` })),
      { role: 'user', content: `latest ${'w'.repeat(36)}` },
    ]
    const provider = createFakeProvider([[textDelta('FORCED SUMMARY')]])
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan }, { force: true })
    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('FORCED SUMMARY')
  })
})
