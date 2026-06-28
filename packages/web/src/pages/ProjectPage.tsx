// ProjectPage.tsx — the builder for the active project: chat ∣ (Preview/Code/Versions over a VS Code-style
// bottom panel: Terminal/Problems/Output/Ports). The bottom panel is ALWAYS mounted — collapse/maximize change
// its size, never its mount position — so terminal sessions survive every layout change.

import { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { BuilderPane } from '@/components/builder/BuilderPane'
import { BottomPanel } from '@/components/builder/BottomPanel'
import { HomePage } from './HomePage'

const Handle = () => (
  <Separator className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring data-[state=dragging]:bg-ring" />
)

// A vertical drag handle that resizes the bottom panel (height in px, clamped to the container).
function VResize({ height, setHeight, containerRef }: { height: number; setHeight: (h: number) => void; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const max = (containerRef.current?.clientHeight ?? 800) - 140
    const move = (ev: PointerEvent) => setHeight(Math.max(120, Math.min(max, startH + (startY - ev.clientY))))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div onPointerDown={onDown} className="h-1 shrink-0 cursor-row-resize bg-border transition-colors hover:bg-ring" />
}

function BuilderArea() {
  const { bottomOpen, bottomMaximized } = useStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [bottomHeight, setBottomHeight] = useState(300)

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      {/* Top builder (Preview/Code/Versions) — hidden (not unmounted) when the panel is maximized. */}
      <div className={cn('min-h-0', bottomMaximized ? 'hidden' : 'flex-1')}>
        <BuilderPane />
      </div>
      {bottomOpen && !bottomMaximized && <VResize height={bottomHeight} setHeight={setBottomHeight} containerRef={containerRef} />}
      {/* Bottom panel — ALWAYS mounted so terminal sessions persist; size/visibility is what changes. */}
      <div
        className={cn('min-h-0 overflow-hidden', !bottomOpen && !bottomMaximized && 'hidden', bottomMaximized && 'flex-1')}
        style={bottomOpen && !bottomMaximized ? { height: bottomHeight } : undefined}
      >
        <BottomPanel />
      </div>
    </div>
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
