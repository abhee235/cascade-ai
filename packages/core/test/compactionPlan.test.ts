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

  it('huge-output models: the wire wall now binds BELOW the absolute-buffer trigger — a deliberate divergence', () => {
    // The old expectation here WAS the fixed-buffer formula (window − 20k reserve − buffer = 367k). But 367k input
    // plus a 128k output cap is 495k against a 400k window — the exact input+cap>window rejection strict
    // servers (vLLM) return 400 for, measured as an unrecoverable loop. A frontier hosted API never
    // collides because its caps and buffers happen to fit; ours must not rely on that luck. The reserve semantics
    // (20k summary budget) are unchanged — only the trigger moves under the wall.
    const p = planCompaction({ window: 400_000, maxOutputTokens: 128_000 })
    expect(p.auto).toBe(400_000 - 128_000 - 1_024) // window − cap − wall margin
    expect(p.auto).toBeLessThan(400_000 - SUMMARY_OUTPUT_RESERVE - AUTOCOMPACT_BUFFER) // below the old fixed-buffer point
  })

  it('the 40K/16K dead zone is closed: auto fires before the wall', () => {
    // The measured failure: window 40,960, default 16,384 cap → the old auto (28,672) sat ABOVE the wire
    // wall (24,576), leaving a band where every request 400s and compaction never rescues it.
    const p = planCompaction({ window: 40_960 }) // no explicit cap ⇒ the provider default applies
    expect(p.auto).toBeLessThanOrEqual(40_960 - 16_384 - 1_024)
    expect(p.warn).toBeLessThan(p.auto)
  })

  it('tiny windows keep their legacy trigger — the wall only binds when the cap is a minority share', () => {
    const small = planCompaction({ window: 8_192 })
    expect(small.auto).toBeGreaterThan(4_096) // NOT halved; the provider-side clamp guards these
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

describe('deep target respects the usable window (the thrash fix)', () => {
	it('40K/16K: the deep stop sits well below the wall-clamped trigger — one event buys many turns', () => {
		// Measured thrash: trigger 23,552, old deep target 0.55 × 40,960 ≈ 22,528 — freeing ~1k that regrew
		// in 1–4 turns (18 compactions in 38 LLM calls). The target now derives from the window the trigger
		// actually governs.
		const p = planCompaction({ window: 40_960, economics: 'constrained' })
		expect(p.deepTarget).toBeLessThan(20_000)
		expect(p.auto - p.deepTarget).toBeGreaterThan(4_000) // real breathing room, not a hair
	})

	it('where the wall does not bind, the target is byte-for-byte the old formula', () => {
		const p = planCompaction({ window: 131_072, maxOutputTokens: 16_384, economics: 'constrained' })
		expect(p.deepTarget).toBe(Math.floor(131_072 * 0.55))
	})
})
