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
  SquareArrowOutUpRight,
  Layers,
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

/** Renders a unified diff inline with colored add/remove/context lines (GitHub-style, compact). Caps very large
 *  diffs so the chat stays scannable. */
function DiffView({ diff }: { diff: string }) {
  const all = diff.split('\n')
  const CAP = 240
  const lines = all.slice(0, CAP)
  return (
    <div className="max-h-72 overflow-auto border-t border-border bg-background/50 font-mono text-[11px] leading-[1.45]">
      {lines.map((l, i) => {
        const c = l[0]
        if (l.startsWith('+++') || l.startsWith('---')) return null // file headers — redundant with the card header
        const cls =
          c === '+' ? 'bg-green-500/10 text-green-600 dark:text-green-400' : c === '-' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : l.startsWith('@@') ? 'text-sky-600 dark:text-sky-400' : 'text-muted-foreground'
        return (
          <div key={i} className={cn('whitespace-pre-wrap px-3', cls)}>
            {l || ' '}
          </div>
        )
      })}
      {all.length > CAP && <div className="px-3 py-1 text-muted-foreground/70">… {all.length - CAP} more lines</div>}
    </div>
  )
}

/** File-edit card: verb + filename + path + +/− stat, expanding to an INLINE diff. A side
 *  action opens the same diff in the Code pane (Monaco) for a fuller view. */
function FileEditCard({ display }: { display: ToolDisplay }) {
  const openFileInCode = useStore((s) => s.openFileInCode)
  const [open, setOpen] = useState(false)
  const Icon = display.op === 'edit' ? FilePen : FilePlus
  const { added, removed } = diffStat(display.diff)
  const name = display.path.split('/').pop()
  const dir = display.path.includes('/') ? display.path.slice(0, display.path.lastIndexOf('/')) : ''
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-border bg-card/60">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground">{display.op === 'create' ? 'Created' : display.op === 'overwrite' ? 'Rewrote' : 'Edited'}</span>
          <span className="font-mono font-medium">{name}</span>
          {dir && <span className="truncate font-mono text-muted-foreground/70">{dir}</span>}
        </button>
        <span className="shrink-0 font-mono text-[10px]">
          {added > 0 && <span className="text-green-500">+{added}</span>}
          {added > 0 && removed > 0 && ' '}
          {removed > 0 && <span className="text-red-500">−{removed}</span>}
        </span>
        <button
          type="button"
          title="Open in the Code pane"
          onClick={() => openFileInCode(display.path, 'diff')}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && <DiffView diff={display.diff} />}
    </div>
  )
}

/** Bash/command card (terminal-style): the command on a dark header, live stdout streaming below, exit status. */
function CommandCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const command = item.summary.replace(/^Running:\s*/, '')
  const StatusIcon = item.status === 'running' ? Loader2 : item.status === 'ok' ? CheckCircle2 : XCircle
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 bg-neutral-900 px-3 py-1.5 font-mono text-[11px] text-neutral-100">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <span className="shrink-0 text-green-400">$</span>
        <span className="min-w-0 flex-1 truncate">{command}</span>
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', item.status === 'running' && 'animate-spin text-neutral-400', item.status === 'ok' && 'text-green-500', item.status === 'error' && 'text-red-500')} />
      </div>
      {item.preview && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap bg-neutral-950 px-3 py-1.5 font-mono text-[11px] text-neutral-300">{item.preview}</pre>
      )}
    </div>
  )
}

/** Collapsed "Thought for Ns" summary that expands to the raw thinking. */
function ThoughtBlock({ thinking, ms }: { thinking: string; ms?: number }) {
  const [open, setOpen] = useState(false)
  const label = ms != null ? `Thought for ${Math.max(1, Math.round(ms / 1000))}s` : 'Thought process'
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs text-muted-foreground">{thinking}</div>}
    </div>
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
        <span className="truncate text-muted-foreground">
          {item.summary || (item.status === 'running' ? 'working…' : '')}
        </span>
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

/** A turn's run of file edits, grouped into one reviewable "change set" with a +/− summary. */
export function ChangeSet({ items }: { items: Extract<Item, { kind: 'tool' }>[] }) {
  const [open, setOpen] = useState(true)
  let added = 0
  let removed = 0
  for (const it of items) if (it.display?.kind === 'fileEdit') ((s) => ((added += s.added), (removed += s.removed)))(diffStat(it.display.diff))
  return (
    <div className="my-1.5 rounded-md border border-border bg-card/40">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs">
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{items.length} files changed</span>
        <span className="ml-auto shrink-0 font-mono text-[10px]">
          <span className="text-green-500">+{added}</span> <span className="text-red-500">−{removed}</span>
        </span>
      </button>
      {open && (
        <div className="px-1.5 pb-1.5">
          {items.map((it, i) => (
            <ActivityCard key={i} item={it} />
          ))}
        </div>
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
      if (item.name.toLowerCase() === 'bash') return <CommandCard item={item} />
      return <ToolCard item={item} />
    }
    default: {
      // User turns are a gray bubble; assistant turns flow as plain text (no repeated role labels).
      if (item.kind === 'user') {
        return <div className="my-3 whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2.5">{item.text}</div>
      }
      return (
        <div className="my-3">
          {item.thinking && <ThoughtBlock thinking={item.thinking} ms={item.thoughtMs} />}
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <Streamdown>{item.text}</Streamdown>
          </div>
        </div>
      )
    }
  }
}
