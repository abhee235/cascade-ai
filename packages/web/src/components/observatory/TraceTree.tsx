// TraceTree.tsx — the span waterfall (ADR-081). Rendering only; the flat→forest fold lives in tree.ts
// (it is logic with edge cases, and keeping it free of React/alias imports is what makes it testable).

import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import type { SpanInfo } from '@cascade/app-protocol'
import { cn } from '@/lib/utils'
import { SpanKindIcon, SpanKindToken, StatusDot } from './SpanKind'
import { TimelineBar } from './TimelineBar'
import { buildForest, countDescendants, traceWindow, type TreeNode } from './tree'
import { CONNECTOR_OFFSET, CONNECTOR_RADIUS, L_CONNECTOR_H, L_CONNECTOR_W, NESTING_INDENT, durationOf, formatDuration, formatTokens, isRunning } from './constants'

interface RowProps {
  node: TreeNode
  depth: number
  ancestorLines: boolean[]
  selectedSpanId: string | null
  onSelect: (id: string) => void
  traceStart: number
  traceMs: number
  forceExpanded: boolean | null
}

function SpanRow({ node, depth, ancestorLines, selectedSpanId, onSelect, traceStart, traceMs, forceExpanded }: RowProps) {
  const [open, setOpen] = useState(true)
  const expanded = forceExpanded ?? open
  const span = node.span
  const hasChildren = node.children.length > 0
  const selected = selectedSpanId === span.spanId
  const running = isRunning(span)
  const error = span.status === 'error'
  const hidden = expanded ? 0 : countDescendants(node)

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setOpen((v) => !v)
  }, [])

  // Error rows draw their rules in the destructive colour so a failing branch is traceable up the tree at
  // a glance — you follow the red rule to the parent rather than reading every name.
  const rule = error ? 'var(--destructive)' : 'var(--border)'
  const tokens = (span.attributes?.inputTokens as number | undefined) ?? undefined
  const outTokens = span.attributes?.outputTokens as number | undefined

  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(span.spanId)}
        className={cn(
          'relative flex w-full items-center border-l-4 py-2 pr-3 text-left text-[13px] transition-colors',
          selected ? 'border-l-primary bg-accent' : 'border-l-transparent hover:bg-accent/40',
        )}
      >
        {/* Ancestor rules: one vertical line per still-open ancestor branch. */}
        {ancestorLines.map((show, i) =>
          show ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the depth level — it is the identity
            <span key={i} className="absolute top-0 bottom-0" style={{ borderLeft: `1px solid ${rule}`, left: i * NESTING_INDENT + CONNECTOR_OFFSET }} />
          ) : null,
        )}
        {/* The elbow joining this row to its parent's rule. */}
        {depth > 0 && (
          <span
            className="absolute"
            style={{
              borderLeft: `1px solid ${rule}`,
              borderBottom: `1px solid ${rule}`,
              borderRadius: `0 0 0 ${CONNECTOR_RADIUS}px`,
              top: -4,
              left: (depth - 1) * NESTING_INDENT + CONNECTOR_OFFSET,
              width: L_CONNECTOR_W,
              height: L_CONNECTOR_H,
            }}
          />
        )}

        <span className="flex min-w-0 flex-1 items-center gap-1.5" style={{ marginLeft: depth * NESTING_INDENT + 14 }}>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {hasChildren ? (
              <span
                onClick={toggle}
                onKeyDown={(e) => e.key === 'Enter' && toggle(e as unknown as React.MouseEvent)}
                role="button"
                tabIndex={-1}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                className="flex h-5 w-5 items-center justify-center rounded bg-foreground/5 transition-transform hover:bg-foreground/10"
                style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </span>
          <SpanKindIcon kind={span.kind} />
          <span className="truncate font-medium">{span.name}</span>
          <SpanKindToken kind={span.kind} />
          {(tokens || outTokens) && (
            <span className="shrink-0 rounded bg-muted/50 px-1 py-0.5 font-mono text-[10px] text-muted-foreground" title="input → output tokens">
              {formatTokens(tokens)}→{formatTokens(outTokens)}
            </span>
          )}
          {hidden > 0 && <span className="shrink-0 rounded bg-muted/50 px-1 py-0.5 text-[10px] text-muted-foreground">+{hidden}</span>}
        </span>

        <span className="flex w-[150px] shrink-0 items-center gap-2">
          <StatusDot status={span.status} running={running} />
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{running ? '…' : formatDuration(durationOf(span))}</span>
          <span className="min-w-0 flex-1">
            <TimelineBar span={span} traceStart={traceStart} traceMs={traceMs} />
          </span>
        </span>
      </button>

      {expanded &&
        node.children.map((child, i) => (
          <SpanRow
            key={child.span.spanId}
            node={child}
            depth={depth + 1}
            ancestorLines={[...ancestorLines, i < node.children.length - 1]}
            selectedSpanId={selectedSpanId}
            onSelect={onSelect}
            traceStart={traceStart}
            traceMs={traceMs}
            forceExpanded={forceExpanded}
          />
        ))}
    </>
  )
}

export function TraceTree({ spans, selectedSpanId, onSelect }: { spans: SpanInfo[]; selectedSpanId: string | null; onSelect: (id: string) => void }) {
  const forest = useMemo(() => buildForest(spans), [spans])
  // null = each row decides for itself. Expand/collapse-all sets it, and the key bump below remounts the
  // rows so their local state restarts from the new default rather than fighting it.
  const [forceExpanded, setForceExpanded] = useState<boolean | null>(null)
  const [epoch, setEpoch] = useState(0)
  const setAll = (v: boolean) => {
    setForceExpanded(v)
    setEpoch((n) => n + 1)
  }

  const { start: traceStart, ms: traceMs } = useMemo(() => traceWindow(spans), [spans])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Spans</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setAll(true)} title="Expand all" className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => setAll(false)} title="Collapse all" className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" key={epoch}>
        {forest.map((root) => (
          <SpanRow
            key={root.span.spanId}
            node={root}
            depth={0}
            ancestorLines={[]}
            selectedSpanId={selectedSpanId}
            onSelect={onSelect}
            traceStart={traceStart}
            traceMs={traceMs}
            forceExpanded={forceExpanded}
          />
        ))}
      </div>
    </div>
  )
}
