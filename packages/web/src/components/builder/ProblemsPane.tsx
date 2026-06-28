// ProblemsPane.tsx — the PROBLEMS tab of the bottom panel (M5.3): runs a type-check in the sandbox and lists
// the errors; "Fix all" hands them to the agent. Each row opens the file in the Code pane.

import { CircleAlert, ListChecks, Loader2, Wand2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

export function ProblemsPane() {
  const { problems, checking, fixProblems, runCheck, openFileInCode, busy } = useStore()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="text-muted-foreground">
          {problems.length} {problems.length === 1 ? 'problem' : 'problems'}
        </span>
        {problems.length > 0 && (
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
        {problems.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {checking ? 'Type-checking…' : 'No problems detected. Run Check to type-check the project.'}
          </div>
        ) : (
          problems.map((p, i) => (
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
          ))
        )}
      </div>
    </div>
  )
}
