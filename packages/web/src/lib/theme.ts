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
