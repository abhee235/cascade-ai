// theme.ts — dark/light theme. Dark is the default; the choice persists in localStorage and is
// applied by toggling the `dark` class on <html> (the token blocks in index.css do the rest).

export type Theme = 'dark' | 'light'
const KEY = 'cascade-theme'

export function getInitialTheme(): Theme {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
  return saved === 'light' || saved === 'dark' ? saved : 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* private mode / no storage — ignore */
  }
}

// ── Accent color (M11 custom themes) ──────────────────────────────────────────────────────────────────────
// One brand color overrides the primary/ring tokens (and their sidebar equivalents) as inline vars on <html>,
// which beat both the light and dark token blocks. CSS variables accept any color string, so a hex value works
// directly — no oklch conversion needed. `null` = the default neutral theme (overrides removed).
const ACCENT_KEY = 'cascade-accent'
const ACCENT_VARS = ['--primary', '--ring', '--sidebar-primary', '--sidebar-ring']

/**
 * Accent presets, chosen so WHITE text clears WCAG AA on every one of them.
 *
 * ADR-084 Phase 1 review. Making contrastFor() honest exposed a second problem: four presets were simply
 * too light to carry white text (Blue 3.68, Green 3.30, Cyan 3.68, Amber 3.19 against a 4.5 floor), so the
 * corrected picker flipped them to black — readable, but black-on-green reads as broken. White on a solid
 * colour button is the near-universal convention.
 *
 * Fixing the RATIO by flipping the text treats the symptom; the cause is the shade. Each of those four is
 * darkened one step so white passes, which keeps the familiar look AND the contrast. Violet and Rose
 * already passed and are unchanged.
 *
 *   Blue  #3b82f6 → #2563eb (white 5.17)    Green #16a34a → #15803d (white 5.02)
 *   Cyan  #0891b2 → #0e7490 (white 5.36)    Amber #d97706 → #b45309 (white 5.02)
 *
 * contrastFor() still guards the CUSTOM colour picker, where an arbitrary pale hex genuinely needs dark
 * text — black on pale yellow is expected; black on green is not.
 */
export const ACCENT_PRESETS: { name: string; hex: string | null }[] = [
  { name: 'Neutral', hex: null },
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Green', hex: '#15803d' },
  { name: 'Rose', hex: '#e11d48' },
  { name: 'Amber', hex: '#b45309' },
  { name: 'Cyan', hex: '#0e7490' },
]

/** Accents saved before the shades above were corrected. A stored value is applied verbatim on load, so
 *  without this an existing user keeps the too-light green — and the black text that made it look wrong. */
const LEGACY_ACCENTS: Record<string, string> = {
  '#3b82f6': '#2563eb',
  '#16a34a': '#15803d',
  '#0891b2': '#0e7490',
  '#d97706': '#b45309',
}

const NEAR_BLACK = '#0a0a0a'

/** WCAG relative luminance. The sRGB gamma linearisation is NOT optional: without it a mid-tone accent
 *  reads as far brighter than it is, and the wrong foreground wins. Returns null for an unparseable hex. */
export function luminance(hex: string): number | null {
  // Validate BEFORE parsing: parseInt('no', 16) is NaN, and coercing that to 0 would score garbage as
  // near-black — a silent wrong answer where the caller wants the documented fallback.
  const body = hex.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(body)) return null
  const [r, g, b] = (body.match(/.{2}/g) as string[]).map((h) => {
    const c = Number.parseInt(h, 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two relative luminances (1–21). */
export const contrastRatio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * Pick the foreground that genuinely contrasts MOST with `hex` — by comparing real ratios, not by a
 * luminance threshold.
 *
 * ADR-084 Phase 1. The old version did `lum > 0.6 ? black : white` on NON-linearised channels, which is
 * wrong twice over: the luminance was inflated, and a threshold cannot promise a ratio. Measured on the
 * shipped `Green` preset #16a34a: it returned white at **3.30:1** (WCAG AA needs 4.5) when black was
 * available at **6.01:1** — so the primary CTA failed contrast on every page of the app, for any user who
 * had picked an accent. Comparing the two candidates is the whole fix.
 */
export function contrastFor(hex: string): string {
  const L = luminance(hex)
  if (L === null) return '#ffffff'
  const onWhite = contrastRatio(L, 1)
  const onBlack = contrastRatio(L, luminance(NEAR_BLACK)!)
  return onBlack > onWhite ? NEAR_BLACK : '#ffffff'
}

/** The contrast the chosen foreground actually achieves on `hex` — what a test (or a picker) asserts. */
export function accentContrast(hex: string): number {
  const L = luminance(hex)
  if (L === null) return 0
  const fg = contrastFor(hex)
  return contrastRatio(L, fg === NEAR_BLACK ? luminance(NEAR_BLACK)! : 1)
}

export function getInitialAccent(): string | null {
  try {
    const saved = localStorage.getItem(ACCENT_KEY)
    if (!saved) return null
    return LEGACY_ACCENTS[saved.toLowerCase()] ?? saved // upgrade a pre-ADR-084 shade in place
  } catch {
    return null
  }
}

export function applyAccent(hex: string | null): void {
  const s = document.documentElement.style
  if (!hex) {
    for (const v of ACCENT_VARS) s.removeProperty(v)
    s.removeProperty('--primary-foreground')
    s.removeProperty('--sidebar-primary-foreground')
  } else {
    const fg = contrastFor(hex)
    for (const v of ACCENT_VARS) s.setProperty(v, hex)
    s.setProperty('--primary-foreground', fg)
    s.setProperty('--sidebar-primary-foreground', fg)
  }
  try {
    if (hex) localStorage.setItem(ACCENT_KEY, hex)
    else localStorage.removeItem(ACCENT_KEY)
  } catch {
    /* ignore */
  }
}
