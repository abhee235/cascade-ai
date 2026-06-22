import { createRoot } from 'react-dom/client'
import { App } from './App'

// Shiki dual-themes (and shadcn tokens) switch colors based on a `.dark` ancestor class.
// VS Code marks the body `vscode-dark` / `vscode-high-contrast` instead, so mirror that onto
// <html> as `.dark`, and keep it in sync when the user switches themes.
function syncTheme() {
  const b = document.body.classList
  const dark = b.contains('vscode-dark') || b.contains('vscode-high-contrast')
  document.documentElement.classList.toggle('dark', dark)
}
syncTheme()
new MutationObserver(syncTheme).observe(document.body, {
  attributes: true,
  attributeFilter: ['class'],
})

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
