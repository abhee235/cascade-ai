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

export const ACCENT_PRESETS: { name: string; hex: string | null }[] = [
  { name: 'Neutral', hex: null },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Green', hex: '#16a34a' },
  { name: 'Rose', hex: '#e11d48' },
  { name: 'Amber', hex: '#d97706' },
  { name: 'Cyan', hex: '#0891b2' },
]

/** Pick a readable foreground (white/near-black) for text/icons sitting on `hex`, by relative luminance. */
function contrastFor(hex: string): string {
  const m = hex.replace('#', '').match(/.{2}/g)
  if (!m) return '#ffffff'
  const [r, g, b] = m.map((h) => Number.parseInt(h, 16) / 255)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.6 ? '#0a0a0a' : '#ffffff'
}

export function getInitialAccent(): string | null {
  try {
    return localStorage.getItem(ACCENT_KEY) || null
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
