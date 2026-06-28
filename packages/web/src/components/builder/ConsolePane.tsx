// ConsolePane.tsx — the Console tab (M5): streams the project's dev-server stdout/stderr (Vite startup,
// HMR updates, build errors) live, and (M5.3) runs a type-check whose problems are listed with a "Fix all"
// that hands them to the agent. Lines arrive as `log` events; problems as `problems` events.

import { useEffect, useRef } from 'react'
import { CircleAlert, Eraser, ListChecks, Loader2, Terminal, Wand2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const isError = (l: string) => /\b(error|err!|failed|cannot|exception|ENOENT|EADDRINUSE)\b/i.test(l)

function ProblemsPanel() {
  const { problems, fixProblems, openFileInCode, busy } = useStore()
  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <CircleAlert className="h-3.5 w-3.5 text-red-500" />
        <span className="font-medium">
          {problems.length} {problems.length === 1 ? 'problem' : 'problems'}
        </span>
        <Button variant="outline" size="xs" className="ml-auto" disabled={busy} onClick={fixProblems}>
          <Wand2 className="h-3.5 w-3.5" /> Fix all
        </Button>
      </div>
      <div className="max-h-40 overflow-auto pb-1">
        {problems.map((p, i) => (
          <button
            key={i}
            onClick={() => openFileInCode(p.file)}
            className="flex w-full items-start gap-2 px-3 py-1 text-left text-xs hover:bg-accent/50"
            title={`Open ${p.file}`}
          >
            <CircleAlert className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
            <span className="min-w-0">
              <span className="text-foreground">{p.message}</span>{' '}
              <span className="font-mono text-muted-foreground/70">
                {p.file}:{p.line}:{p.col}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function ConsolePane() {
  const { logs, preview, checking, problems, clearLogs, startPreview, runCheck } = useStore()
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => endRef.current?.scrollIntoView(), [logs])

  const active = preview?.status === 'running' || preview?.status === 'starting' || preview?.status === 'installing'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium">Dev server</span>
        <span className="text-muted-foreground">{preview?.status ?? 'stopped'}</span>
        <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" disabled={checking} onClick={runCheck}>
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
          {checking ? 'Checking…' : 'Check'}
        </Button>
        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={clearLogs}>
          <Eraser className="h-3.5 w-3.5" /> Clear
        </Button>
      </div>

      {problems.length > 0 && <ProblemsPanel />}

      {!active && logs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
          <Terminal className="h-8 w-8 opacity-50" />
          <p className="text-sm font-medium">Console</p>
          <p className="text-xs opacity-70">
            {checking ? 'Type-checking…' : problems.length === 0 ? 'No problems. Run the preview to stream dev-server logs.' : ' '}
          </p>
          <Button size="sm" onClick={startPreview}>Run preview</Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-card/30 px-3 py-2 font-mono text-xs leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-muted-foreground">Waiting for output…</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className={cn('whitespace-pre-wrap break-all', isError(l) && 'text-red-500')}>
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
