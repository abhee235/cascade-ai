// ActivityCard.tsx — one transcript row, dispatched by Item kind. The agent-action (tool) cards use an
// icon+label map keyed by tool name. As we add richer cards (file-edit diffs, AddDependency, MCP), they
// slot in here.

import { useEffect, useState } from 'react'
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
  ListTodo,
  CheckSquare,
  Square,
  CircleSlash,
  type LucideIcon,
} from 'lucide-react'
import type { ToolDisplay, TodoItem } from '@cascade/core'
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
function FileEditCard({ display }: { display: Extract<ToolDisplay, { kind: 'fileEdit' }> }) {
  const openFileInCode = useStore((s) => s.openFileInCode)
  const [open, setOpen] = useState(false)
  const Icon = display.op === 'edit' ? FilePen : FilePlus
  const { added, removed } = diffStat(display.diff)
  const name = display.path.split('/').pop()
  const dir = display.path.includes('/') ? display.path.slice(0, display.path.lastIndexOf('/')) : ''
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-card/60">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
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

/** A human label for a shell command, so the card header reads "Building" not "npm run build". */
function commandLabel(cmd: string): string {
  const c = cmd.toLowerCase()
  const has = (...xs: string[]) => xs.some((x) => c.includes(x))
  if (has('npm install', 'npm ci', 'pnpm install', 'yarn install', 'bun install')) return 'Installing dependencies'
  if (has('prisma migrate', 'db:migrate')) return 'Running migration'
  if (has('db:seed', 'prisma db seed', 'seed.ts', 'seed.js')) return 'Seeding database'
  if (has('prisma generate', 'db:generate')) return 'Generating Prisma client'
  if (has('run dev', 'concurrently', 'vite --host', 'tsx watch', 'next dev')) return 'Starting dev server'
  if (has('run build', 'vite build', 'tsc -b', 'tsc --build', 'next build')) return 'Building'
  if (has('vitest', 'jest', 'npm test', 'run test', 'playwright test')) return 'Running tests'
  if (has('biome', 'eslint', 'run lint', 'prettier', 'run format')) return 'Linting / formatting'
  if (has('curl', 'fetch(', '/health', 'wget')) return 'Checking endpoint'
  if (has('pkill', 'kill -', 'kill ')) return 'Stopping process'
  if (has('git ')) return 'Git'
  if (has('mkdir', 'rm -', 'cp ', 'mv ', 'touch ')) return 'File operation'
  if (has('prisma')) return 'Prisma'
  const first = (cmd.trim().split(/\s+/)[0] || 'command').split('/').pop() || 'command'
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/** Bash/command card — collapsible (like the file-edit card): a meaningful label + the raw command on a
 *  themed header; the stdout is tucked behind a click. Errors auto-expand so the failure is visible. */
function CommandCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const command = item.summary.replace(/^Running:\s*/, '')
  const running = item.status === 'running'
  const [open, setOpen] = useState(false)
  // Surface a failure without a click.
  useEffect(() => {
    if (item.status === 'error') setOpen(true)
  }, [item.status])
  const StatusIcon = running ? Loader2 : item.status === 'ok' ? CheckCircle2 : item.status === 'interrupted' ? CircleSlash : XCircle
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-border bg-card/60">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {commandLabel(command)}
          {running && '…'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">{command}</span>
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', running && 'animate-spin text-muted-foreground', item.status === 'ok' && 'text-green-500', item.status === 'error' && 'text-red-500', item.status === 'interrupted' && 'text-muted-foreground/70')} />
      </button>
      {open && item.preview && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t border-border bg-muted/50 px-3 py-1.5 font-mono text-[11px] text-foreground/80">{item.preview}</pre>
      )}
    </div>
  )
}

/** Collapsed "Thought for Ns" summary that expands to the raw thinking. The collapsed row also carries the
 *  thought's FIRST LINE as a dimmed preview, so a stack of thought cards reads as "what was each about"
 *  instead of identical timer rows. */
function ThoughtBlock({ thinking, ms }: { thinking: string; ms?: number }) {
  const [open, setOpen] = useState(false)
  const label = ms != null ? `Thought for ${Math.max(1, Math.round(ms / 1000))}s` : 'Thought process'
  const preview = thinking.trimStart().split('\n', 1)[0]
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1 text-left text-[13px] leading-[21px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0">{label}</span>
        {!open && preview && <span className="min-w-0 flex-1 truncate pl-2 text-muted-foreground/50">{preview}</span>}
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-[21px] text-muted-foreground">{thinking}</div>}
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
  const StatusIcon = item.status === 'running' ? Loader2 : item.status === 'ok' ? CheckCircle2 : item.status === 'interrupted' ? CircleSlash : XCircle
  const hasOutput = !!item.preview
  // A NAKED log row — no border, no background. Status leads ("Simmer complete ✓");
  // 13px muted; hierarchy from type, not boxes. Click still expands output.
  return (
    <div className="my-0">
      <button
        type="button"
        disabled={!hasOutput}
        onClick={() => setOpen((o) => !o)}
        className={cn('group flex w-full items-center gap-2 py-1 text-[13px] text-muted-foreground', hasOutput && 'hover:text-foreground')}
      >
        <StatusIcon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            item.status === 'running' && 'animate-spin text-primary',
            item.status === 'ok' && 'text-muted-foreground/70',
            item.status === 'error' && 'text-destructive',
            item.status === 'interrupted' && 'text-muted-foreground/70',
          )}
        />
        <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
        
        <span className="truncate">{(item.summary || (item.status === 'running' ? 'working…' : '')).split('/workspace/').join('')}</span>
        {item.status === 'interrupted' && <span className="shrink-0 text-[11px] text-muted-foreground/70">interrupted</span>}
        {hasOutput && (
          <ChevronRight className={cn('ml-auto h-3 w-3 shrink-0 opacity-0 transition-all group-hover:opacity-60', open && 'rotate-90 opacity-60')} />
        )}
      </button>
      {open && hasOutput && (
        <pre className="mb-1 ml-[22px] max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-secondary/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {item.preview}
        </pre>
      )}
    </div>
  )
}

/** The agent's task checklist (TodoWrite). Pending = empty box, in_progress = spinner (shows the activeForm),
 *  completed = checked + struck through. */
function TodoCard({ items }: { items: TodoItem[] }) {
  // A todo list is a SNAPSHOT taken when the agent last wrote it, so an item left 'in_progress' by a turn
  // that ended keeps spinning forever — the checklist claims work is happening when nothing is running.
  // The turn state is the missing piece: same task, but stop animating once the turn is over.
  const busy = useStore((s) => s.busy)
  const done = items.filter((t) => t.status === 'completed').length
  return (
    <div className="my-4 rounded-md border border-border bg-card/80 p-2.5 text-[13px] text--muted-foreground">
      <div className="mb-1.5 flex items-center gap-2 font-medium text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5" /> Tasks
        <span className="ml-auto font-mono text-[10px]">
          {done}/{items.length}
        </span>
      </div>
      <div className="space-y-1">
        {items.map((t, i) => (
          <div key={i} className="flex items-start gap-2">
            {t.status === 'completed' ? (
              <CheckSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
            ) : t.status === 'in_progress' ? (
              <Loader2 className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500', busy ? 'animate-spin' : 'opacity-50')} />
            ) : (
              <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn('min-w-0', t.status === 'completed' && 'text-muted-foreground line-through', t.status === 'in_progress' && 'font-medium text-foreground')}>
              {t.status === 'in_progress' ? t.activeForm : t.content}
            </span>
          </div>
        ))}
      </div>
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
      if (item.display?.kind === 'todos') return <TodoCard items={item.display.items} />
      if (item.display?.kind === 'fileEdit') return <FileEditCard display={item.display} />
      if (item.name.toLowerCase() === 'bash') return <CommandCard item={item} />
      return <ToolCard item={item} />
    }
    default: {
      // User turns are a gray bubble; assistant turns flow as plain text (no repeated role labels).
      if (item.kind === 'user') {
        // A QUIET bubble — barely-there wash, tighter radius, same 13px/21 as the prose.
        return <div className="my-3 whitespace-pre-wrap rounded-xl bg-secondary/70 px-3.5 py-2.5 text-[13px] leading-[21px]">{item.text}</div>
      }
      if (item.kind === 'question') return null // ADR-043: rendered by QuestionCard in ChatPanel, not here
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
