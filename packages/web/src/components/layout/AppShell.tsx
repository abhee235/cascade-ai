// AppShell.tsx — the 3-pane builder shell: TitleBar on top, then a resizable horizontal split of
// Sidebar (projects) | ChatPanel | BuilderPane. The left rail collapses via the store.

import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStore } from '../../lib/store'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { ChatPanel } from '../chat/ChatPanel'
import { BuilderPane } from '../builder/BuilderPane'

const Handle = () => (
  <Separator className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring data-[state=dragging]:bg-ring" />
)

export function AppShell() {
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)

  return (
    <div className="flex h-screen flex-col bg-background text-sm text-foreground">
      <TitleBar />
      <Group orientation="horizontal" className="flex min-h-0 flex-1">
        {!sidebarCollapsed && (
          <>
            <Panel defaultSize="16%" minSize="12%" maxSize="28%">
              <Sidebar />
            </Panel>
            <Handle />
          </>
        )}
        <Panel defaultSize="42%" minSize="25%">
          <ChatPanel />
        </Panel>
        <Handle />
        <Panel defaultSize="42%" minSize="20%">
          <BuilderPane />
        </Panel>
      </Group>
    </div>
  )
}
