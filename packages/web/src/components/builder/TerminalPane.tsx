// TerminalPane.tsx — the integrated terminal (M7): an xterm.js view of a real `sh` running in the project's
// sandbox container. Keystrokes stream to the PTY; output arrives as `terminalData` events and is written to
// xterm IMPERATIVELY (the store exposes a `terminalSink` we register here — we don't keep output in React
// state). xterm.js is the same engine VS Code uses, so it looks like the VS Code terminal.

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '@/lib/store'

// A dark theme (the integrated terminal is dark even in light mode, like VS Code).
const THEME = {
  background: '#0b0b0c',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: '#33415580',
  black: '#18181b',
  brightBlack: '#52525b',
}

export function TerminalPane() {
  const ref = useRef<HTMLDivElement>(null)

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
      theme: THEME,
    })
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
      term.dispose()
    }
  }, [])

  return <div ref={ref} className="h-full w-full overflow-hidden bg-[#0b0b0c] px-2 py-1" />
}
