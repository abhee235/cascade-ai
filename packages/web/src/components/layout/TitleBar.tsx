import { PanelLeft } from 'lucide-react'
import { useStore } from '../../lib/store'
import { cn } from '../../lib/utils'

export function TitleBar() {
  const { connected, projects, activeId, toggleSidebar } = useStore()
  const activeName = projects.find((p) => p.id === activeId)?.name

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <button
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Toggle sidebar"
        onClick={toggleSidebar}
      >
        <PanelLeft className="h-4 w-4" />
      </button>
      <span className="font-semibold tracking-wide">Cascade</span>
      {activeName && <span className="text-muted-foreground">/ {activeName}</span>}
      <span
        className={cn(
          'ml-auto inline-flex items-center gap-1.5 text-xs',
          connected ? 'text-green-400' : 'text-muted-foreground',
        )}
      >
        <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-green-400' : 'bg-muted-foreground/50')} />
        {connected ? 'connected' : 'connecting…'}
      </span>
    </header>
  )
}
