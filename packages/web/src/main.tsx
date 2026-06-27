import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme, getInitialTheme } from './lib/theme'
import './lib/monaco' // self-host the Monaco editor (no CDN loader)
import './index.css'

// Apply the saved theme before first paint (no flash).
applyTheme(getInitialTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
