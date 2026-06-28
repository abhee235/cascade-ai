// TerminalPane.tsx — the integrated terminal (M7): an xterm.js view of a real `sh` running in the project's
// sandbox container. Keystrokes stream to the PTY; output arrives as `terminalData` events and is written to
// xterm IMPERATIVELY (the store exposes a `terminalSink` we register here). xterm.js is the same engine VS
// Code uses, so it looks like the VS Code terminal. The theme follows the app's light/dark mode.

import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '@/lib/store'

// xterm needs concrete colors (not CSS vars), so we keep palettes matched to our neutral theme tokens and
// switch them with the app theme.
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

export function TerminalPane() {
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
    try {
      fit.fit()
    } catch {
      /* element may not be measured yet — the ResizeObserver fits once it is */
    }

    setTerminalSink((chunk) => term.write(chunk)) // server output → xterm
    term.onData((d) => terminalInput(d)) // keystrokes → PTY (never filtered; confinement is the boundary)
    startTerminal(term.cols, term.rows)

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        terminalResize(term.cols, term.rows)
      } catch {
        /* ignore transient 0-size */
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      setTerminalSink(undefined)
      stopTerminal()
      termRef.current = null
      term.dispose()
    }
  }, [])

  // Live-update the palette when the app theme toggles (without recreating the terminal).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFor(theme)
  }, [theme])

  return <div ref={ref} className="h-full w-full overflow-hidden bg-background px-2 py-1" />
}
