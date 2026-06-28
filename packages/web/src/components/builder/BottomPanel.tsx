// BottomPanel.tsx — the VS Code-style bottom panel (M7): TERMINAL · PROBLEMS · OUTPUT · PORTS tabs with a
// toolbar (new/kill terminal, maximize, hide). The terminal is xterm.js — the same engine VS Code uses — so
// it looks like the VS Code integrated terminal. The Terminal tab is mounted only while active (keyed by
// project + a counter so "new terminal" spawns a fresh shell).

import { useState } from 'react'
import { Maximize2, Minimize2, Plus, Trash2, X, type LucideIcon } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { BottomTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { TerminalPane } from './TerminalPane'
import { ConsolePane } from './ConsolePane'
import { ProblemsPane } from './ProblemsPane'
import { PortsPane } from './PortsPane'

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
  { id: 'ports', label: 'Ports' },
]

function IconBtn({ title, onClick, icon: Icon }: { title: string; onClick: () => void; icon: LucideIcon }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

export function BottomPanel() {
  const { bottomTab, setBottomTab, toggleBottom, toggleBottomMax, bottomMaximized, activeId, problems, stopTerminal } = useStore()
  const [termKey, setTermKey] = useState(0) // bump to remount TerminalPane → a fresh shell ("new terminal")

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center border-b border-border pl-1 pr-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setBottomTab(t.id)}
            className={cn(
              'relative px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition-colors',
              bottomTab === t.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.id === 'problems' && problems.length > 0 && (
              <span className="ml-1 rounded-full bg-red-500/15 px-1 py-0.5 text-[10px] text-red-500">{problems.length}</span>
            )}
            {bottomTab === t.id && <span className="absolute inset-x-1 -bottom-px h-0.5 bg-foreground" />}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-0.5">
          {bottomTab === 'terminal' && (
            <>
              <span className="px-1.5 text-[11px] text-muted-foreground">sh</span>
              <IconBtn title="New terminal" icon={Plus} onClick={() => setTermKey((k) => k + 1)} />
              <IconBtn title="Kill terminal" icon={Trash2} onClick={stopTerminal} />
            </>
          )}
          <IconBtn title={bottomMaximized ? 'Restore panel' : 'Maximize panel'} icon={bottomMaximized ? Minimize2 : Maximize2} onClick={toggleBottomMax} />
          <IconBtn title="Hide panel (Ctrl+`)" icon={X} onClick={toggleBottom} />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {bottomTab === 'terminal' ? (
          <TerminalPane key={`${activeId}-${termKey}`} />
        ) : bottomTab === 'problems' ? (
          <ProblemsPane />
        ) : bottomTab === 'output' ? (
          <ConsolePane />
        ) : (
          <PortsPane />
        )}
      </div>
    </div>
  )
}
