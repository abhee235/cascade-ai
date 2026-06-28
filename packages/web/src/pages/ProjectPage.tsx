// ProjectPage.tsx — the builder for the active project: chat ∣ (Preview/Code/Versions over a VS Code-style
// bottom panel: Terminal/Problems/Output/Ports). Only reachable once a project is open.

import { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStore } from '@/lib/store'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { BuilderPane } from '@/components/builder/BuilderPane'
import { BottomPanel } from '@/components/builder/BottomPanel'
import type { BottomTab } from '@/lib/types'
import { HomePage } from './HomePage'

const Handle = () => (
  <Separator className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring data-[state=dragging]:bg-ring" />
)
const VHandle = () => (
  <Separator className="h-px shrink-0 cursor-row-resize bg-border transition-colors hover:bg-ring data-[state=dragging]:bg-ring" />
)

// When the panel is hidden, a thin strip lets the user reopen it on a chosen tab (like VS Code's collapsed panel).
function CollapsedBar() {
  const setBottomTab = useStore((s) => s.setBottomTab)
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-t border-border bg-card px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {(['terminal', 'problems', 'output', 'ports'] as BottomTab[]).map((t) => (
        <button key={t} type="button" onClick={() => setBottomTab(t)} className="px-2 py-0.5 transition-colors hover:text-foreground">
          {t}
        </button>
      ))}
    </div>
  )
}

// The right side: Preview/Code/Versions over the collapsible/maximizable bottom panel.
function BuilderArea() {
  const { bottomOpen, bottomMaximized } = useStore()
  if (bottomMaximized) return <BottomPanel />
  if (!bottomOpen) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <BuilderPane />
        </div>
        <CollapsedBar />
      </div>
    )
  }
  return (
    <Group orientation="vertical" className="flex h-full flex-col">
      <Panel minSize="15%">
        <BuilderPane />
      </Panel>
      <VHandle />
      <Panel defaultSize="34%" minSize="10%" maxSize="85%">
        <BottomPanel />
      </Panel>
    </Group>
  )
}

export function ProjectPage() {
  const { activeId, projects, toggleBottom } = useStore()
  const name = projects.find((p) => p.id === activeId)?.name

  // Ctrl+` toggles the bottom panel (VS Code's shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        toggleBottom()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleBottom])

  if (!activeId) return <HomePage /> // safety: no project ⇒ fall back to the entry page

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
        <SidebarTrigger className="text-muted-foreground" />
        <span className="truncate font-medium">{name}</span>
      </header>
      <Group orientation="horizontal" className="flex min-h-0 flex-1">
        <Panel defaultSize="400px" minSize="320px" maxSize="460px">
          <ChatPanel />
        </Panel>
        <Handle />
        <Panel minSize="40%">
          <BuilderArea />
        </Panel>
      </Group>
    </div>
  )
}
