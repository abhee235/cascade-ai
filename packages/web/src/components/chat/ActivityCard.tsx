// ActivityCard.tsx — one transcript row, dispatched by Item kind. The agent-action (tool) cards use an
// icon+label map keyed by tool name. As we add richer cards (file-edit diffs, AddDependency, MCP), they
// slot in here.

import { useState } from 'react'
import { Streamdown } from 'streamdown'
import {
  Terminal,
  FileText,
  FilePen,
  FilePlus,
  FileSearch,
  Search,
  Globe,
  Bot,
  Wrench,
  CheckCircle2,
  ChevronRight,
  XCircle,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import type { ToolDisplay } from '@cascade/core'
import type { Item } from '../../lib/types'
import { useStore } from '../../lib/store'
import { cn } from '../../lib/utils'

function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff.split('\n')) {
    if (l[0] === '+') added++
    else if (l[0] === '-') removed++
  }
  return { added, removed }
}

/** Compact, clickable file-edit card: verb + filename + path + +/− stat. The actual diff
 *  opens in the Code pane (Monaco DiffEditor) on click — not inline in the chat. */
function FileEditCard({ display }: { display: ToolDisplay }) {
  const openFileInCode = useStore((s) => s.openFileInCode)
  const Icon = display.op === 'edit' ? FilePen : FilePlus
  const { added, removed } = diffStat(display.diff)
  const name = display.path.split('/').pop()
  const dir = display.path.includes('/') ? display.path.slice(0, display.path.lastIndexOf('/')) : ''
  return (
    <button
      onClick={() => openFileInCode(display.path, 'diff')}
      title="Open diff in the Code pane"
      className="my-1.5 flex w-full items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs hover:bg-accent/50"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{display.op === 'create' ? 'Created' : display.op === 'overwrite' ? 'Rewrote' : 'Edited'}</span>
      <span className="font-mono font-medium">{name}</span>
      {dir && <span className="truncate font-mono text-muted-foreground/70">{dir}</span>}
      <span className="ml-auto shrink-0 font-mono text-[10px]">
        {added > 0 && <span className="text-green-500">+{added}</span>}
        {added > 0 && removed > 0 && ' '}
        {removed > 0 && <span className="text-red-500">−{removed}</span>}
      </span>
    </button>
  )
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  read: FileText,
  write: FileText,
  edit: FilePen,
  glob: FileSearch,
  grep: Search,
  webfetch: Globe,
  websearch: Globe,
  subagent: Bot,
}
const iconFor = (name: string) => TOOL_ICONS[name.toLowerCase()] ?? Wrench

/** Compact tool card: just a one-line header by default (no content dump in the chat). If the tool produced
 *  output (Bash stdout, search results, etc.) it's collapsed behind a click — keeping the chat clean. */
function ToolCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const Icon = iconFor(item.name)
  const StatusIcon = item.status === 'running' ? Loader2 : item.status === 'ok' ? CheckCircle2 : XCircle
  const hasOutput = !!item.preview
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-border bg-card/60">
      <button
        type="button"
        disabled={!hasOutput}
        onClick={() => setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-xs', hasOutput && 'hover:bg-accent/40')}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono font-semibold">{item.name}</span>
        <span className="truncate text-muted-foreground">{item.summary}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {hasOutput && <ChevronRight className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-90')} />}
          <StatusIcon
            className={cn(
              'h-3.5 w-3.5',
              item.status === 'running' && 'animate-spin text-muted-foreground',
              item.status === 'ok' && 'text-green-500',
              item.status === 'error' && 'text-red-500',
            )}
          />
        </span>
      </button>
      {open && hasOutput && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {item.preview}
        </pre>
      )}
    </div>
  )
}

export function ActivityCard({ item }: { item: Item }) {
  switch (item.kind) {
    case 'memory':
      return (
        <div className="my-1 border-l-2 border-purple-500/60 px-2 text-xs italic text-muted-foreground">
          💾 Remembered: {item.text}
        </div>
      )
    case 'compacted':
      return (
        <div className="my-2 border-y border-dashed border-border py-1 text-center text-xs italic text-muted-foreground">
          🗜 Context compacted — {item.text}
        </div>
      )
    case 'tool': {
      if (item.display?.kind === 'fileEdit') return <FileEditCard display={item.display} />
      return <ToolCard item={item} />
    }
    default: {
      // user | assistant
      const isUser = item.kind === 'user'
      return (
        <div className={cn('my-2 rounded-lg px-3 py-2', isUser ? 'bg-accent' : 'bg-card/50')}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{item.kind}</div>
          {item.kind === 'assistant' && item.thinking && (
            <details className="mb-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">💭 Thinking</summary>
              <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2">{item.thinking}</div>
            </details>
          )}
          {item.kind === 'assistant' ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <Streamdown>{item.text}</Streamdown>
            </div>
          ) : (
            <div className="whitespace-pre-wrap">{item.text}</div>
          )}
        </div>
      )
    }
  }
}
