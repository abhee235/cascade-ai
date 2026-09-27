// VersionsPane.tsx — the Versions tab (M6): the project's git checkpoint history. A checkpoint is saved
// after each change; "Restore" rewinds the working tree to that commit (the preview hot-reloads on its own).

import { GitCommitHorizontal, History, RotateCcw } from 'lucide-react'
import { useStore } from '@/lib/store'
import { relativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function VersionsPane() {
  const { versions, restoreVersion } = useStore()

  if (versions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <History className="h-8 w-8 opacity-50" />
        <p className="text-sm font-medium">Versions</p>
        <p className="text-xs opacity-70">Checkpoints are saved automatically after each change.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      {versions.map((v, i) => (
        <div key={v.id} className="group flex items-center gap-3 border-b border-border px-4 py-2.5">
          <GitCommitHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{v.summary}</div>
            <div className="text-xs text-muted-foreground">{relativeTime(v.createdAt)}</div>
          </div>
          {i === 0 ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">current</span>
          ) : (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0 opacity-0 group-hover:opacity-100"
              onClick={() => restoreVersion(v.id)}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Restore
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
