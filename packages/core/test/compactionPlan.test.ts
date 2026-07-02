import { describe, it, expect } from 'vitest'
import {
  planCompaction,
  resolveCompactionPlan,
  SUMMARY_OUTPUT_RESERVE,
  AUTOCOMPACT_BUFFER,
  WARN_BUFFER,
  DEFAULT_PROPORTIONAL_PCT,
  DEFAULT_WINDOW,
} from '../src/context/compactionPlan'

describe('compactionPlan — no-regression (large windows keep the absolute-buffer rule)', () => {
  // THE guarantee (ADR-039): on big windows the AUTO trigger — the thing that could regress a strong model —
  // must equal the fixed-buffer formula exactly (threshold = effectiveWindow − AUTOCOMPACT_BUFFER).
  // If a future small-model tweak shifts the big-window trigger, this fails — that's the tripwire.
  it.each([131_072, 200_000, 1_000_000])('window %i: auto trigger is exactly the absolute-buffer threshold', (window) => {
    const p = planCompaction({ window })
    expect(p.effectiveWindow).toBe(window - SUMMARY_OUTPUT_RESERVE)
    expect(p.auto).toBe(window - SUMMARY_OUTPUT_RESERVE - AUTOCOMPACT_BUFFER) // == fixed-buffer threshold — THE guarantee
    // warn fires before auto, no earlier than the absolute warn tier. Below the ~132k crossover the proportional
    // floor (0.6·window) can nudge warn slightly later than the absolute warn — harmless, and useful on small windows.
    expect(p.warn).toBeGreaterThanOrEqual(p.auto - WARN_BUFFER)
    expect(p.warn).toBeLessThan(p.auto)
  })

  it('warn tier is exactly the absolute-buffer value once that branch dominates (≥200k)', () => {
    for (const window of [200_000, 1_000_000]) {
      const p = planCompaction({ window })
      expect(p.warn).toBe(p.auto - WARN_BUFFER) // == the absolute warning threshold
    }
  })

  it('reserve is capped at the summary budget even for huge output models', () => {
    // A model that can emit 128k still only reserves the 20k summary budget on a large window.
    const p = planCompaction({ window: 400_000, maxOutputTokens: 128_000 })
    expect(p.auto).toBe(400_000 - SUMMARY_OUTPUT_RESERVE - AUTOCOMPACT_BUFFER)
  })
})

describe('compactionPlan — small windows fall back to proportional', () => {
  it('32k model: the proportional branch dominates (0.7 · window)', () => {
    const p = planCompaction({ window: 32_768, maxOutputTokens: 8_192 })
    expect(p.auto).toBe(Math.floor(DEFAULT_PROPORTIONAL_PCT * 32_768)) // 22937
  })

  it('never triggers after the input budget is exhausted (auto ≤ effectiveWindow)', () => {
    for (const window of [4_096, 8_192, 16_384, 32_768, 64_000]) {
      const p = planCompaction({ window })
      expect(p.auto).toBeLessThanOrEqual(p.effectiveWindow)
    }
  })

  it('tiny windows cannot reserve the full 20k summary budget', () => {
    const p = planCompaction({ window: 8_192 })
    expect(window8kReserve(p)).toBeLessThanOrEqual(Math.floor(8_192 * 0.25))
  })
})

describe('compactionPlan — invariants across the whole range', () => {
  it.each([4_096, 8_192, 16_384, 32_768, 128_000, 200_000, 1_000_000])(
    'window %i keeps 0 ≤ warn ≤ auto ≤ hard ≤ window',
    (window) => {
      const p = planCompaction({ window })
      expect(p.warn).toBeGreaterThanOrEqual(0)
      expect(p.warn).toBeLessThanOrEqual(p.auto)
      expect(p.auto).toBeLessThanOrEqual(p.hard)
      expect(p.hard).toBeLessThanOrEqual(p.window)
      expect(p.keepRecentTokens).toBeLessThan(p.effectiveWindow || 1)
    },
  )

  it('masks harder on small windows than large ones', () => {
    const small = planCompaction({ window: 32_768 }).toolResultMaxChars
    const large = planCompaction({ window: 1_000_000 }).toolResultMaxChars
    expect(small).toBeLessThan(large)
  })
})

describe('resolveCompactionPlan — window resolution', () => {
  it('override > model map > default', () => {
    expect(resolveCompactionPlan({ model: 'gpt-4o' }).window).toBe(128_000) // model map
    expect(resolveCompactionPlan({ model: 'totally-unknown' }).window).toBe(DEFAULT_WINDOW) // default
    expect(resolveCompactionPlan({ model: 'gpt-4o', contextWindow: 16_000 }).window).toBe(16_000) // override
  })
})

function window8kReserve(p: { window: number; effectiveWindow: number }): number {
  return p.window - p.effectiveWindow
}
