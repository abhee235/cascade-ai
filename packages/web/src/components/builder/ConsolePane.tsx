// ConsolePane.tsx — the OUTPUT view of the bottom panel (M5): streams the project's dev-server stdout/stderr
// (Vite startup, HMR, build errors) live. Lines arrive as `log` events. (Problems moved to its own tab.)

import { useEffect, useRef } from 'react'
import { Eraser, SquareTerminal } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const isError = (l: string) => /\b(error|err!|failed|cannot|exception|ENOENT|EADDRINUSE)\b/i.test(l)

export function ConsolePane() {
  const { logs, preview, clearLogs, startPreview } = useStore()
  const endRef = useRef<HTMLDivElement>(null)
  // Braces matter: the concise arrow RETURNED scrollIntoView()'s result, and React treats any truthy
  // return from an effect as a cleanup fn — "destroy is not a function", unmounting the whole tree. It was
  // latent while this pane only mounted on tab-select; keeping every pane mounted surfaced it at page load.
  useEffect(() => {
    endRef.current?.scrollIntoView()
  }, [logs])

  const active = preview?.status === 'running' || preview?.status === 'starting' || preview?.status === 'installing'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium">Dev server</span>
        <span className="text-muted-foreground">{preview?.status ?? 'stopped'}</span>
        <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={clearLogs}>
          <Eraser className="h-3.5 w-3.5" /> Clear
        </Button>
      </div>

      {!active && logs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
          <SquareTerminal className="h-8 w-8 opacity-50" />
          <p className="text-xs opacity-70">Run the preview to stream dev-server logs.</p>
          <Button size="sm" onClick={startPreview}>Run preview</Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-card/30 px-3 py-2 font-mono text-xs leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-muted-foreground">Waiting for output…</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className={cn('whitespace-pre-wrap break-all', isError(l) && 'text-danger')}>
                {l || ' '}
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  )
}
