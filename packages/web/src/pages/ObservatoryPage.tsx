// ObservatoryPage.tsx — the in-app trace viewer (ADR-081 §5).
//
// Traces stopped being dev tooling this cycle: the 114-turn thrash, the narration loop, the silently-8k
// context window were each diagnosed by reading one. That work needed a separate Phoenix install and a
// terminal. This is the same view, in the product, over the app's own SQLite store — so "why did that
// build go wrong?" is answerable by the person it went wrong for.
//
// Pull-based on purpose: a build writes hundreds of spans a minute, and pushing them would flood the
// socket to render a page nobody may have open. The poll below runs ONLY while this page is mounted,
// which also makes a running turn watchable — spans are readable as soon as they are flushed.

import { useEffect, useMemo } from 'react'
import { ArrowLeft, Radar, RefreshCw } from 'lucide-react'
import type { SpanInfo, TraceSummaryInfo } from '@cascade/app-protocol'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SpanKindIcon, StatusDot } from '@/components/observatory/SpanKind'
import { SpanDetail } from '@/components/observatory/SpanDetail'
import { TraceTree } from '@/components/observatory/TraceTree'
import { formatDuration, formatTimeAgo, formatTokens } from '@/components/observatory/constants'

const POLL_MS = 3000

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-xs font-medium">{value}</span>
    </div>
  )
}

/** The summary strip. Derived from the loaded page of traces, not queried separately — one source, so the
 *  numbers can never disagree with the rows underneath them. */
function StatsBar({ traces }: { traces: TraceSummaryInfo[] }) {
  const stats = useMemo(() => {
    const done = traces.filter((t) => t.durationMs != null)
    const totalMs = done.reduce((n, t) => n + (t.durationMs ?? 0), 0)
    return {
      spans: traces.reduce((n, t) => n + t.spanCount, 0),
      errors: traces.filter((t) => t.status === 'error').length,
      avgMs: done.length ? totalMs / done.length : null,
      models: [...new Set(traces.map((t) => t.model).filter(Boolean))] as string[],
    }
  }, [traces])

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-6 py-2.5">
      <StatItem label="Turns" value={String(traces.length)} />
      <StatItem label="Spans" value={String(stats.spans)} />
      <StatItem label="Errors" value={String(stats.errors)} />
      <StatItem label="Avg" value={formatDuration(stats.avgMs)} />
      {stats.models.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Models</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{stats.models.slice(0, 3).join(', ')}</span>
        </div>
      )}
    </div>
  )
}

function TraceList({ traces, loaded, names, onOpen }: { traces: TraceSummaryInfo[]; loaded: boolean; names: Map<string, string>; onOpen: (id: string) => void }) {
  if (!loaded)
    return (
      <div className="space-y-2 p-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-md bg-muted/50" />
        ))}
      </div>
    )

  if (!traces.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Radar className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No traces yet.</p>
        <p className="max-w-sm text-xs text-muted-foreground/70">Every message you send a project is recorded here — the model calls it made, the tools it ran, and how long each took.</p>
      </div>
    )

  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-6">
      {/* A grid, not a table: the columns must stay aligned while each row is a single click target. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-4 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span />
        <span>Turn</span>
        <span className="justify-self-end">Spans</span>
        <span className="justify-self-end">Duration</span>
        <span className="justify-self-end">Model</span>
        <span className="justify-self-end">When</span>
      </div>
      {traces.map((t) => (
        <button
          key={t.traceId}
          type="button"
          onClick={() => onOpen(t.traceId)}
          className={cn(
            'grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-4 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent',
          )}
        >
          <StatusDot status={t.status} running={t.running} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{t.name}</span>
            {t.projectId && <span className="block truncate text-xs text-muted-foreground">{names.get(t.projectId) ?? 'unknown project'}</span>}
          </span>
          <span className="justify-self-end font-mono text-xs text-muted-foreground">{t.spanCount}</span>
          {/* A running turn has no total yet — showing the closed spans' extent would read as a fast turn. */}
          <span className={cn('justify-self-end font-mono text-xs', t.running && 'text-blue-500')}>{t.running ? 'running…' : formatDuration(t.durationMs)}</span>
          <span className="max-w-[10rem] justify-self-end truncate font-mono text-xs text-muted-foreground">{t.model ?? '—'}</span>
          <span className="justify-self-end text-xs text-muted-foreground">{formatTimeAgo(t.startedAt)}</span>
        </button>
      ))}
    </div>
  )
}

function TraceDetail({ trace, spans, onBack }: { trace: TraceSummaryInfo | undefined; spans: SpanInfo[] | undefined; onBack: () => void }) {
  const selectedSpanId = useStore((s) => s.selectedSpanId)
  const selectSpan = useStore((s) => s.selectSpan)

  // Land on the root span rather than an empty panel — for most turns the root IS the summary you want.
  useEffect(() => {
    if (!selectedSpanId && spans?.length) selectSpan((spans.find((s) => !s.parentSpanId) ?? spans[0]).spanId)
  }, [spans, selectedSpanId, selectSpan])

  const selected = spans?.find((s) => s.spanId === selectedSpanId) ?? null
  const tokens = spans?.reduce((n, s) => n + ((s.attributes?.outputTokens as number | undefined) ?? 0), 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={onBack} title="Back to traces">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{trace?.name ?? 'Trace'}</span>
        <div className="hidden items-center gap-4 sm:flex">
          <StatItem label="Spans" value={String(spans?.length ?? trace?.spanCount ?? 0)} />
          <StatItem label="Duration" value={trace?.running ? 'running…' : formatDuration(trace?.durationMs)} />
          <StatItem label="Output" value={formatTokens(tokens)} />
        </div>
      </div>

      {spans ? (
        // Fixed left column rather than a resizable split: we have no resizable primitive, and a 2-pane
        // layout with one scrollable side is exactly what this view needs. Both panes scroll internally so
        // the page itself never does.
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(22rem,34%)_1fr]">
          <div className="hidden min-h-0 border-r lg:block">
            <TraceTree spans={spans} selectedSpanId={selectedSpanId} onSelect={selectSpan} />
          </div>
          {/* Below lg the tree stacks above the detail instead of disappearing. */}
          <div className="flex min-h-0 flex-col lg:hidden">
            <div className="max-h-64 min-h-0 border-b">
              <TraceTree spans={spans} selectedSpanId={selectedSpanId} onSelect={selectSpan} />
            </div>
            <div className="min-h-0 flex-1">
              <SpanDetail span={selected} />
            </div>
          </div>
          <div className="hidden min-h-0 lg:block">
            <SpanDetail span={selected} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading spans…</div>
      )}
    </div>
  )
}

export function ObservatoryPage() {
  const { traces, tracesLoaded, openTraceId, traceSpans, projects, requestTraces, openTrace, closeTrace } = useStore()

  // Poll while mounted. Re-requesting the OPEN trace too keeps a live turn's waterfall growing on screen;
  // both requests are cheap reads against a local DB, and the interval dies with the page.
  useEffect(() => {
    requestTraces()
    const t = setInterval(() => {
      requestTraces()
      const id = useStore.getState().openTraceId
      if (id) useStore.getState().send({ type: 'trace', action: 'spans', traceId: id })
    }, POLL_MS)
    return () => clearInterval(t)
  }, [requestTraces])

  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const openTraceSummary = traces.find((t) => t.traceId === openTraceId)

  if (openTraceId) return <TraceDetail trace={openTraceSummary} spans={traceSpans[openTraceId]} onBack={closeTrace} />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <SpanKindIcon kind="AGENT" size={20} />
            Observatory
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Every turn the agent has taken — the model calls, the tools, and where the time went.</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => requestTraces()} title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <StatsBar traces={traces} />
      <TraceList traces={traces} loaded={tracesLoaded} names={names} onOpen={openTrace} />
    </div>
  )
}
