// ProblemsPane.tsx — the PROBLEMS tab of the bottom panel (M5.3): runs a type-check in the sandbox and lists
// the errors; "Fix all" hands them to the agent. Each row opens the file in the Code pane.

import { CircleAlert, Flame, ListChecks, Loader2, Wand2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

export function ProblemsPane() {
  const { problems, runtimeErrors, checking, fixProblems, runCheck, openFileInCode, busy } = useStore()
  const total = problems.length + runtimeErrors.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="text-muted-foreground">
          {total} {total === 1 ? 'problem' : 'problems'}
        </span>
        {total > 0 && (
          <Button variant="outline" size="xs" disabled={busy} onClick={fixProblems}>
            <Wand2 className="h-3.5 w-3.5" /> Fix all
          </Button>
        )}
        <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" disabled={checking} onClick={runCheck}>
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
          {checking ? 'Checking…' : 'Check'}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {total === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {checking ? 'Type-checking…' : 'No problems. Build/runtime errors from the preview show here automatically; Check runs a type-check.'}
          </div>
        ) : (
          <>
            {/* Build/runtime errors from the running preview (Vite overlay + window.onerror) */}
            {runtimeErrors.map((e, i) => (
              <div key={`r${i}`} className="flex items-start gap-2 px-3 py-1 text-xs">
                <Flame className="mt-0.5 h-3 w-3 shrink-0 text-orange-500" />
                <span className="min-w-0">
                  <span className="mr-1 rounded bg-orange-500/15 px-1 text-[10px] uppercase text-orange-600">{e.kind}</span>
                  <span className="whitespace-pre-wrap text-foreground">{e.message}</span>
                  {e.file && <span className="ml-1 font-mono text-muted-foreground/70">{e.file}</span>}
                </span>
              </div>
            ))}
            {/* TypeScript type-check errors (from Check) */}
            {problems.map((p, i) => (
              <button
                key={`t${i}`}
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
          </>
        )}
      </div>
    </div>
  )
}
