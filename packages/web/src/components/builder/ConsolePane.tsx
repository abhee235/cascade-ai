// ConsolePane.tsx — the Console tab (M5): streams the project's dev-server stdout/stderr (Vite startup,
// HMR updates, build errors) live. Lines arrive as `log` BuilderEvents and are appended to the store.

import { useEffect, useRef } from 'react'
import { Eraser, Terminal } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const isError = (l: string) => /\b(error|err!|failed|cannot|exception|ENOENT|EADDRINUSE)\b/i.test(l)

export function ConsolePane() {
  const { logs, preview, clearLogs, startPreview } = useStore()
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => endRef.current?.scrollIntoView(), [logs])

  const active = preview?.status === 'running' || preview?.status === 'starting' || preview?.status === 'installing'

  // Nothing to show and no dev server running → invite the user to run it.
  if (!active && logs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
        <Terminal className="h-8 w-8 opacity-50" />
        <p className="text-sm font-medium">Console</p>
        <p className="text-xs opacity-70">Run the preview to stream the dev-server logs here.</p>
        <Button size="sm" onClick={startPreview}>Run preview</Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium">Dev server</span>
        <span className="text-muted-foreground">{preview?.status ?? 'stopped'}</span>
        <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={clearLogs}>
          <Eraser className="h-3.5 w-3.5" /> Clear
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-card/30 px-3 py-2 font-mono text-xs leading-relaxed">
        {logs.length === 0 ? (
          <div className="text-muted-foreground">Waiting for output…</div>
        ) : (
          logs.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-all', isError(l) && 'text-red-500')}>
              {l || ' '}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}
