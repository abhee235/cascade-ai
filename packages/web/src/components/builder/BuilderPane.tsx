// BuilderPane.tsx — the right pane of the 3-pane builder shell: a tabbed surface (Preview | Code | Console),
// built on shadcn/Radix Tabs. M1 ships the shell + tabs with empty states; live preview (iframe + proxy),
// file tree + Monaco, and console get wired in their milestones.

// BuilderPane.tsx — the top of the builder's right side: Preview · Code · Versions tabs. (Console/Problems/
// Terminal/Ports live in the VS Code-style bottom panel — see BottomPanel.tsx.)
import { Code2, Eye, History, SquareTerminal, type LucideIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useStore } from '@/lib/store'
import type { RightTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { CodePane } from './CodePane'
import { PreviewPane } from './PreviewPane'
import { VersionsPane } from './VersionsPane'

const TABS: { id: RightTab; label: string; icon: LucideIcon; title: string; sub: string }[] = [
  { id: 'preview', label: 'Preview', icon: Eye, title: 'Live preview', sub: 'Runs the project in a sandbox and shows it here.' },
  { id: 'code', label: 'Code', icon: Code2, title: 'Code', sub: 'File tree + editor.' },
  { id: 'versions', label: 'Versions', icon: History, title: 'Versions', sub: 'Checkpoints + restore.' },
]

export function BuilderPane() {
  const { rightTab, setRightTab, activeId, bottomOpen, toggleBottom, setBottomTab } = useStore()

  return (
    <Tabs
      value={rightTab}
      onValueChange={(v) => setRightTab(v as RightTab)}
      className="flex h-full flex-col gap-0 bg-background"
    >
      <div className="flex h-11 shrink-0 items-center border-b border-border px-2">
        <TabsList variant="line">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Toggle the bottom panel (Terminal/Problems/Output/Ports). Sits right after the tabs (not far right)
            with a divider so it reads as the obvious way to open the terminal. */}
        <div className="mx-2 h-5 w-px shrink-0 bg-border" />
        <button
          type="button"
          onClick={() => (bottomOpen ? toggleBottom() : setBottomTab('terminal'))}
          title="Toggle panel (Ctrl+`)"
          className={cn(
            'flex items-center gap-1.5 rounded px-2 py-1 text-sm transition-colors',
            bottomOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <SquareTerminal className="h-4 w-4" /> Terminal
        </button>
      </div>

      {TABS.map((t) =>
        t.id === 'code' ? (
          <TabsContent key={t.id} value={t.id} className="min-h-0">
            <CodePane />
          </TabsContent>
        ) : t.id === 'preview' ? (
          <TabsContent key={t.id} value={t.id} className="min-h-0">
            <PreviewPane />
          </TabsContent>
        ) : t.id === 'versions' ? (
          <TabsContent key={t.id} value={t.id} className="min-h-0">
            <VersionsPane />
          </TabsContent>
        ) : (
          <TabsContent key={t.id} value={t.id} className="flex items-center justify-center p-6 text-center">
            <div className="text-muted-foreground">
              <t.icon className="mx-auto h-8 w-8 opacity-50" />
              <p className="mt-2 text-sm font-medium">{t.title}</p>
              <p className="mt-1 text-xs opacity-70">{activeId ? t.sub : 'Open a project to start.'}</p>
            </div>
          </TabsContent>
        ),
      )}
    </Tabs>
  )
}
