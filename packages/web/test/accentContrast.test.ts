// ADR-084 Phase 1 — the accent foreground must be READABLE, for every preset and any custom hex.
//
// The bug this pins: applyAccent() overrides --primary with the user's accent and derives
// --primary-foreground from it. The old derivation used a luminance THRESHOLD on non-linearised sRGB
// channels, so for the shipped Green preset it chose white at 3.30:1 when black was available at 6.01:1 —
// and the primary CTA ("New project", in the persistent sidebar) then failed WCAG AA on every page of the
// app. Measured live 2026-09-27 at 3.3:1; the default neutral theme was unaffected, which is why a clean
// browser profile does not reproduce it.
import { describe, expect, it } from 'vitest'
import { ACCENT_PRESETS, accentContrast, contrastFor, contrastRatio, luminance } from '../src/lib/theme'

const AA = 4.5

describe('luminance — WCAG relative luminance, gamma-linearised', () => {
  it('anchors at the extremes', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1, 5)
    expect(luminance('#000000')).toBeCloseTo(0, 5)
  })

  it('white-on-black is 21:1 — the sanity anchor the audit script also asserts', () => {
    expect(contrastRatio(luminance('#ffffff')!, luminance('#000000')!)).toBeCloseTo(21, 1)
  })

  it('linearises: mid-grey is ~0.216, NOT the 0.5 a raw-channel average would give', () => {
    // #808080 is the exact case that made the old threshold misjudge mid-tones.
    expect(luminance('#808080')!).toBeCloseTo(0.2159, 3)
  })

  it('returns null for an unparseable value rather than guessing', () => {
    expect(luminance('nonsense')).toBeNull()
  })
})

describe('contrastFor — pick the better of the two candidates, not a threshold', () => {
  it('every shipped accent preset reaches WCAG AA with the foreground it picks', () => {
    const failures = ACCENT_PRESETS.filter((p) => p.hex).map((p) => ({ name: p.name, hex: p.hex!, ratio: +accentContrast(p.hex!).toFixed(2) })).filter((r) => r.ratio < AA)
    expect(failures, `presets below ${AA}:1 → ${JSON.stringify(failures)}`).toEqual([])
  })

  // The presets additionally have to LOOK right. A solid accent button carries white text nearly
  // everywhere in this industry; passing AA by flipping to black reads as broken on blue/green/cyan.
  // So each preset is dark enough for white — the shade is the fix, not the text colour.
  it('every preset is dark enough that WHITE text passes — the conventional look', () => {
    const notWhite = ACCENT_PRESETS.filter((p) => p.hex).map((p) => ({ name: p.name, hex: p.hex!, fg: contrastFor(p.hex!), white: +contrastRatio(luminance(p.hex!)!, 1).toFixed(2) })).filter((r) => r.fg !== '#ffffff' || r.white < AA)
    expect(notWhite, `presets that cannot carry white text → ${JSON.stringify(notWhite)}`).toEqual([])
  })

  it('THE regression: Green #16a34a takes black at ~6.0, not white at ~3.3', () => {
    expect(contrastFor('#16a34a')).toBe('#0a0a0a')
    expect(accentContrast('#16a34a')).toBeGreaterThan(5.9)
    // What the old code produced, kept as the counter-example:
    expect(contrastRatio(luminance('#16a34a')!, 1)).toBeCloseTo(3.3, 1) // white → fails AA
  })

  it('still chooses white where white genuinely wins (a dark accent)', () => {
    expect(contrastFor('#7c3aed')).toBe('#ffffff')
    expect(accentContrast('#7c3aed')).toBeGreaterThan(AA)
  })

  it('never returns a foreground worse than the alternative, across the hue circle', () => {
    // A blunt sweep: for any accent, the chosen fg must be at least as good as the one not chosen.
    for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
      const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
      const L = luminance(hex)!
      const chosen = contrastFor(hex) === '#0a0a0a' ? contrastRatio(L, luminance('#0a0a0a')!) : contrastRatio(L, 1)
      const other = contrastFor(hex) === '#0a0a0a' ? contrastRatio(L, 1) : contrastRatio(L, luminance('#0a0a0a')!)
      expect(chosen, `${hex} picked the worse foreground`).toBeGreaterThanOrEqual(other)
    }
  })
})
