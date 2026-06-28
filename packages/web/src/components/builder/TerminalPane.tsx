// TerminalPane.tsx — one xterm.js terminal session (M7) bound to a server-side PTY in the sandbox container.
// Keyed by session `id`; multiple can be mounted at once (only the active one is visible). Output arrives as
// `terminalData` events routed to the per-session sink we register here. xterm.js is the same engine VS Code
// uses, so it looks like the VS Code terminal; the palette follows the app's light/dark mode.

import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '@/lib/store'

// xterm needs concrete colors (not CSS vars), so we keep palettes matched to our neutral theme tokens.
const DARK: ITheme = {
  background: '#1a1a1a',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#3f3f4680',
}
const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#27272a',
  cursor: '#27272a',
  cursorAccent: '#ffffff',
  selectionBackground: '#cbd5e1',
}
const themeFor = (t: string): ITheme => (t === 'dark' ? DARK : LIGHT)

export function TerminalPane({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const theme = useStore((s) => s.theme)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { startTerminal, stopTerminal, terminalInput, terminalResize, setTerminalSink } = useStore.getState()

    const term = new Terminal({
      scrollback: 1000, // bound memory (untrusted program output)
      allowProposedApi: false, // no unstable/risky APIs
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"Geist Mono", ui-monospace, "Cascadia Code", Menlo, monospace',
      fontSize: 13,
      theme: themeFor(useStore.getState().theme),
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit) // only fit — NO clipboard(OSC 52)/image addons (untrusted-output risk)
    term.open(el)

    const doFit = () => {
      try {
        fit.fit()
      } catch {
        /* element not measured yet */
      }
    }
    // Fit AFTER layout so the last row isn't clipped (the container must have its real height first).
    requestAnimationFrame(() => {
      doFit()
      setTerminalSink(id, (chunk) => term.write(chunk)) // server output → xterm
      startTerminal(id, term.cols, term.rows) // size the PTY to the fitted terminal
    })
    term.onData((d) => terminalInput(id, d)) // keystrokes → PTY (never filtered; confinement is the boundary)

    const ro = new ResizeObserver(() => {
      doFit()
      terminalResize(id, term.cols, term.rows)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      setTerminalSink(id, undefined)
      stopTerminal(id)
      termRef.current = null
      term.dispose()
    }
  }, [id])

  // Live-update the palette when the app theme toggles (without recreating the terminal).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFor(theme)
  }, [theme])

  return <div ref={ref} className="h-full w-full overflow-hidden" />
}
