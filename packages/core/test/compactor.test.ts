import { describe, it, expect } from 'vitest'
import {
  resolveCompactConfig,
  estimateTokens,
  olderBoundary,
  maskObservations,
  compactIfNeeded,
  type CompactConfig,
} from '../src/context/compactor'
import { createFakeProvider, textDelta } from './fakeProvider'
import type { Message } from '../src/protocol'

describe('compactor — sizing & helpers', () => {
  it('resolveCompactConfig: override > model map > default; ratios default', () => {
    expect(resolveCompactConfig({ model: 'gpt-4o' }).window).toBe(128_000) // map
    expect(resolveCompactConfig({ model: 'totally-unknown' }).window).toBe(8192) // default
    expect(resolveCompactConfig({ model: 'gpt-4o', contextWindow: 16_000 }).window).toBe(16_000) // override
    const c = resolveCompactConfig({ model: 'x' })
    expect([c.compactRatio, c.keepRecentRatio]).toEqual([0.8, 0.25])
  })

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
})

describe('compactor — compactIfNeeded', () => {
  const cfg: CompactConfig = { window: 100, compactRatio: 0.8, keepRecentRatio: 0.25 } // compactAt=80 tok, keepRecent=25 tok

  it('under threshold ⇒ no change', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const provider = createFakeProvider([])
    const { kind } = await compactIfNeeded(msgs, { provider, model: 'fake', config: cfg })
    expect(kind).toBe('none')
  })

  it('Phase A: masking large old tool output is enough ⇒ kind "masked"', async () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'A'.repeat(4000) }] }, // ~1000 tok, older
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
    ]
    const provider = createFakeProvider([]) // summarize must NOT be called
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', config: cfg })
    expect(kind).toBe('masked')
    expect((messages[0].content as any)[0].content).toMatch(/output masked/)
    expect(provider.calls.length).toBe(0)
  })

  it('Phase B: summarizes the older half into one message, keeps recent verbatim', async () => {
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
      config: cfg,
      onDiscard: async (o) => void discarded.push(o),
    })
    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('STRUCTURED SUMMARY OF OLDER') // summary replaces older
    expect(messages.length).toBeLessThan(older.length + recent.length) // history shrank
    expect(messages[messages.length - 1].content).toContain('latest') // most-recent message kept verbatim
    expect(discarded[0].length).toBeGreaterThan(0) // coupled-curation hook saw the older messages
  })
})
