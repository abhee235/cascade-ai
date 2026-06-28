// ProjectPage.tsx — the builder for the active project: chat ∣ (code/preview). Only reachable once a project
// is open (the Home page is the entry point), so there's no "chat with no project" anymore.

import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStore } from '@/lib/store'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { BuilderPane } from '@/components/builder/BuilderPane'
import { HomePage } from './HomePage'

const Handle = () => (
  <Separator className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring data-[state=dragging]:bg-ring" />
)

export function ProjectPage() {
  const { activeId, projects } = useStore()
  const name = projects.find((p) => p.id === activeId)?.name

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
          <BuilderPane />
        </Panel>
      </Group>
    </div>
  )
}
