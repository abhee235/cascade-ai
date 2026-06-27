// BuilderPane.tsx — the right pane of the 3-pane builder shell: a tabbed surface (Preview | Code | Console).
// M1 ships the shell + tabs with empty states; the live preview (iframe + proxy), file tree + Monaco, and
// console get wired in their milestones. Tabs are driven by the store (rightTab).

import { Eye, Code2, SquareTerminal, type LucideIcon } from 'lucide-react'
import { useStore } from '../../lib/store'
import type { RightTab } from '../../lib/types'
import { cn } from '../../lib/utils'

const TABS: { id: RightTab; label: string; icon: LucideIcon }[] = [
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'code', label: 'Code', icon: Code2 },
  { id: 'console', label: 'Console', icon: SquareTerminal },
]

const PLACEHOLDER: Record<RightTab, { icon: LucideIcon; title: string; sub: string }> = {
  preview: { icon: Eye, title: 'Live preview', sub: 'Runs the project in a sandbox and shows it here (coming soon).' },
  code: { icon: Code2, title: 'Code', sub: 'File tree + editor (coming soon).' },
  console: { icon: SquareTerminal, title: 'Console', sub: 'Dev-server logs + terminal (coming soon).' },
}

export function BuilderPane() {
  const { rightTab, setRightTab, activeId } = useStore()
  const ph = PLACEHOLDER[rightTab]

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = t.id === rightTab
          return (
            <button
              key={t.id}
              onClick={() => setRightTab(t.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="text-muted-foreground">
          <ph.icon className="mx-auto h-8 w-8 opacity-50" />
          <p className="mt-2 text-sm font-medium">{ph.title}</p>
          <p className="mt-1 text-xs opacity-70">{activeId ? ph.sub : 'Open a project to start.'}</p>
        </div>
      </div>
    </div>
  )
}
