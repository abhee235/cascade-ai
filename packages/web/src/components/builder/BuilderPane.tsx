// BuilderPane.tsx — the right pane of the 3-pane builder shell: a tabbed surface (Preview | Code | Console),
// built on shadcn/Radix Tabs. M1 ships the shell + tabs with empty states; live preview (iframe + proxy),
// file tree + Monaco, and console get wired in their milestones.

import { Code2, Eye, History, SquareTerminal, type LucideIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useStore } from '@/lib/store'
import type { RightTab } from '@/lib/types'
import { CodePane } from './CodePane'
import { PreviewPane } from './PreviewPane'
import { ConsolePane } from './ConsolePane'
import { VersionsPane } from './VersionsPane'

const TABS: { id: RightTab; label: string; icon: LucideIcon; title: string; sub: string }[] = [
  { id: 'preview', label: 'Preview', icon: Eye, title: 'Live preview', sub: 'Runs the project in a sandbox and shows it here (coming soon).' },
  { id: 'code', label: 'Code', icon: Code2, title: 'Code', sub: 'File tree + editor (coming soon).' },
  { id: 'console', label: 'Console', icon: SquareTerminal, title: 'Console', sub: 'Dev-server logs + terminal (coming soon).' },
  { id: 'versions', label: 'Versions', icon: History, title: 'Versions', sub: 'Checkpoints + restore (coming soon).' },
]

export function BuilderPane() {
  const { rightTab, setRightTab, activeId } = useStore()

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
        ) : t.id === 'console' ? (
          <TabsContent key={t.id} value={t.id} className="min-h-0">
            <ConsolePane />
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
