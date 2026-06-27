import { Moon, PanelLeft, Sun } from 'lucide-react'
import { useStore } from '../../lib/store'
import { cn } from '../../lib/utils'

export function TitleBar() {
  const { connected, projects, activeId, toggleSidebar, theme, toggleTheme } = useStore()
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
          connected ? 'text-green-500' : 'text-muted-foreground',
        )}
      >
        <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-green-500' : 'bg-muted-foreground/50')} />
        {connected ? 'connected' : 'connecting…'}
      </span>
      <button
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        onClick={toggleTheme}
      >
        {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </header>
  )
}
