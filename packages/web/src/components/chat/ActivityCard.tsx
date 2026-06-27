// ActivityCard.tsx — one transcript row, dispatched by Item kind. The agent-action (tool) cards use an
// icon+label map keyed by tool name. As we add richer cards (file-edit diffs, AddDependency, MCP), they
// slot in here.

import { Streamdown } from 'streamdown'
import {
  Terminal,
  FileText,
  FilePen,
  FileSearch,
  Search,
  Globe,
  Bot,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import type { Item } from '../../lib/types'
import { cn } from '../../lib/utils'

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
      const Icon = iconFor(item.name)
      const StatusIcon = item.status === 'running' ? Loader2 : item.status === 'ok' ? CheckCircle2 : XCircle
      return (
        <div className="my-1.5 overflow-hidden rounded-md border border-border bg-card/60">
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono font-semibold">{item.name}</span>
            <span className="text-muted-foreground">{item.summary}</span>
            <StatusIcon
              className={cn(
                'ml-auto h-3.5 w-3.5',
                item.status === 'running' && 'animate-spin text-muted-foreground',
                item.status === 'ok' && 'text-green-500',
                item.status === 'error' && 'text-red-500',
              )}
            />
          </div>
          {item.preview && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              {item.preview}
            </pre>
          )}
        </div>
      )
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
