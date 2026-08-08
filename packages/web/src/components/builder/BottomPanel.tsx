// BottomPanel.tsx — the VS Code-style bottom panel (M7): TERMINAL · PROBLEMS · OUTPUT · PORTS tabs + a
// toolbar. The Terminal tab supports MULTIPLE sessions (a sub-strip of tabs; "+" adds one, the trash kills the
// active one). All sessions stay mounted (only the active one is visible) so switching never resets a shell.

import { useEffect, useRef } from 'react'
import { Maximize2, Minimize2, Plus, SquareTerminal, Trash2, X, type LucideIcon } from 'lucide-react'
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

// The Terminal tab: a session sub-strip + all sessions mounted (only the active one visible).
function TerminalSessions() {
  const { terminals, activeTerminalId, activeId, bottomTab, bottomOpen, newTerminal, closeTerminal, setActiveTerminal } = useStore()

  // Ensure there's always a session while the Terminal tab is open (a fresh one per project). The ref guard
  // stops React StrictMode's double-invoked effect from spawning two before state settles.
  //
  // No longer gated on Docker (ADR-081 §4): host mode has a terminal too. It is a different thing — a
  // line-oriented shell on this machine rather than a pty inside a container — and it says so itself when
  // it opens, which is better than the dead end this used to render.
  const creating = useRef(false)
  useEffect(() => {
    // Only spawn a session once the panel is actually OPEN — the panel stays mounted (just hidden) when
    // closed, so gating on `bottomOpen` keeps the terminal (and thus the panel) HIDDEN by default instead of
    // auto-opening on project load. Opening the Terminal tab flips bottomOpen → this creates the session.
    if (bottomOpen && bottomTab === 'terminal' && activeId && terminals.length === 0 && !creating.current) {
      creating.current = true
      newTerminal()
    } else if (terminals.length > 0) {
      creating.current = false
    }
  }, [bottomOpen, bottomTab, activeId, terminals.length, newTerminal])


  return (
    <div className="flex h-full min-h-0 bg-background">
      {/* terminal content (all sessions mounted; only the active one is visible) */}
      <div className="relative min-h-0 flex-1">
        {terminals.map((tid) => (
          <div key={tid} className={cn('absolute inset-0', tid === activeTerminalId ? '' : 'invisible')}>
            <TerminalPane id={tid} />
          </div>
        ))}
      </div>
      {/* session list — vertical, on the right (like VS Code) */}
      {terminals.length > 0 && (
        <div className="w-44 shrink-0 overflow-auto border-l border-border bg-card py-1">
          {terminals.map((tid, i) => (
            <div
              key={tid}
              onClick={() => setActiveTerminal(tid)}
              className={cn(
                'group flex cursor-pointer items-center gap-2 px-3 py-1 text-xs transition-colors',
                tid === activeTerminalId ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">sh {i + 1}</span>
              <button
                type="button"
                title="Kill"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(tid)
                }}
                className="opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function BottomPanel() {
  const { bottomTab, setBottomTab, toggleBottom, toggleBottomMax, bottomMaximized, problems, runtimeErrors, activeTerminalId, newTerminal, closeTerminal } = useStore()
  const problemCount = problems.length + runtimeErrors.length

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
            {t.id === 'problems' && problemCount > 0 && (
              <span className="ml-1 rounded-full bg-red-500/15 px-1 py-0.5 text-[10px] text-red-500">{problemCount}</span>
            )}
            {bottomTab === t.id && <span className="absolute inset-x-1 -bottom-px h-0.5 bg-foreground" />}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-0.5">
          {bottomTab === 'terminal' && (
            <>
              <IconBtn title="New terminal" icon={Plus} onClick={newTerminal} />
              <IconBtn title="Kill terminal" icon={Trash2} onClick={() => activeTerminalId && closeTerminal(activeTerminalId)} />
            </>
          )}
          <IconBtn title={bottomMaximized ? 'Restore panel' : 'Maximize panel'} icon={bottomMaximized ? Minimize2 : Maximize2} onClick={toggleBottomMax} />
          <IconBtn title="Hide panel (Ctrl+`)" icon={X} onClick={toggleBottom} />
        </div>
      </div>

      {/* All panes stay MOUNTED; the inactive ones are merely invisible — the same rule the terminal
          session strip already follows, now applied one level up. The ternary this replaces unmounted the
          terminal pane on every tab switch, destroying the xterm instance (and the scrollback) while the
          shell lived on server-side — and output arriving while another tab was open was dropped entirely,
          because the data sink unregisters on unmount. visibility, not display:none, so xterm keeps real
          dimensions and mounts correctly even while another tab is active. */}
      <div className="relative min-h-0 flex-1">
        <div className={cn('absolute inset-0', bottomTab !== 'terminal' && 'invisible')}><TerminalSessions /></div>
        <div className={cn('absolute inset-0', bottomTab !== 'problems' && 'invisible')}><ProblemsPane /></div>
        <div className={cn('absolute inset-0', bottomTab !== 'output' && 'invisible')}><ConsolePane /></div>
        <div className={cn('absolute inset-0', bottomTab !== 'ports' && 'invisible')}><PortsPane /></div>
      </div>
    </div>
  )
}
