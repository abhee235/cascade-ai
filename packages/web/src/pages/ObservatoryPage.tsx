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

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, MessagesSquare, Radar, RefreshCw, Search, X } from 'lucide-react'
import type { SessionInfo, SpanInfo, TraceSummaryInfo } from '@cascade/app-protocol'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SpanKindIcon, SpanKindToken, StatusDot } from '@/components/observatory/SpanKind'
import { SpanDetail } from '@/components/observatory/SpanDetail'
import { TraceTree } from '@/components/observatory/TraceTree'
import { durationOf, formatDuration, formatTimeAgo, formatTokens, isRunning } from '@/components/observatory/constants'
import { traceWindow } from '@/components/observatory/tree'

const POLL_MS = 3000

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
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
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Models</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{stats.models.slice(0, 3).join(', ')}</span>
        </div>
      )}
    </div>
  )
}

/** A pill that reads as a toggle. Used for every filter so "what is narrowing this list" is one glance. */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * The filter bar. Every control here answers a question the trace list alone cannot:
 * "which turns failed", "what was this project doing", "how did the model I just switched to behave".
 * The free-text box is deliberately dual-purpose — it searches TRACES by prompt, and one click turns the
 * same text into a cross-trace SPAN search, because those are the same hunt from the user's side.
 */
function FilterBar({ projects }: { projects: { id: string; name: string }[] }) {
  const { traceFilter, traceModels, setTraceFilter, spanSearch, searchSpans, observatoryView, setObservatoryView, openSessionId } = useStore()
  const [text, setText] = useState(traceFilter.q ?? '')

  const submit = () => setTraceFilter({ q: text.trim() || undefined })
  const grouped = observatoryView === 'sessions' && !openSessionId

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      {/* Conversations vs individual turns. Grouped leads because the conversation is the unit of work;
          flat is what you switch to when hunting ACROSS the history (every error, one model). */}
      <div className="flex shrink-0 rounded-md border p-0.5">
        {(['sessions', 'turns'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setObservatoryView(v)}
            className={cn('rounded px-2.5 py-1 text-xs transition-colors', observatoryView === v ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {v === 'sessions' ? 'Conversations' : 'All turns'}
          </button>
        ))}
      </div>

      {/* The prompt/error filters narrow TURNS; in the grouped view there is nothing for them to narrow. */}
      {grouped ? (
        <div className="flex-1" />
      ) : (
      <>
      <div className="relative min-w-[16rem] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') {
              setText('')
              setTraceFilter({ q: undefined })
              searchSpans(null)
            }
          }}
          onBlur={submit}
          placeholder="Search prompts…"
          className="h-8 pl-8 text-sm"
        />
      </div>

      <Chip active={!!spanSearch} onClick={() => (spanSearch ? searchSpans(null) : searchSpans({ q: text.trim() }))}>
        {spanSearch ? 'Searching spans' : 'Search spans instead'}
      </Chip>

      <span className="mx-1 h-4 w-px bg-border" />

      <Chip active={traceFilter.status === 'error'} onClick={() => setTraceFilter({ status: traceFilter.status === 'error' ? undefined : 'error' })}>
        Errors only
      </Chip>
      </>
      )}

      {projects.length > 1 && (
        <select
          value={traceFilter.projectId ?? ''}
          onChange={(e) => setTraceFilter({ projectId: e.target.value || undefined })}
          className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs text-muted-foreground"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}

      {traceModels.length > 1 && (
        <select
          value={traceFilter.model ?? ''}
          onChange={(e) => setTraceFilter({ model: e.target.value || undefined })}
          className="h-8 shrink-0 rounded-md border bg-background px-2 font-mono text-xs text-muted-foreground"
        >
          <option value="">All models</option>
          {traceModels.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/**
 * Cross-trace span results — the view that makes this more than a viewer. "Is this the third time Bash
 * failed this way?" cannot be asked one trace at a time, and it is the question you actually have after
 * watching a build go wrong twice.
 */
function SpanResults({ spans, names, onOpen }: { spans: SpanInfo[] | null; names: Map<string, string>; onOpen: (traceId: string, spanId: string) => void }) {
  const { spanSearch, searchSpans } = useStore()
  const KINDS = ['LLM', 'TOOL', 'CHAIN']

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <span className="text-xs text-muted-foreground">{spans ? `${spans.length} span${spans.length === 1 ? '' : 's'}` : 'Searching…'}</span>
        <span className="mx-1 h-4 w-px bg-border" />
        {KINDS.map((k) => (
          <Chip key={k} active={spanSearch?.kind === k} onClick={() => searchSpans({ kind: spanSearch?.kind === k ? undefined : k })}>
            {k.toLowerCase()}
          </Chip>
        ))}
        <Chip active={spanSearch?.status === 'error'} onClick={() => searchSpans({ status: spanSearch?.status === 'error' ? undefined : 'error' })}>
          Failed only
        </Chip>
      </div>

      {spans && !spans.length ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          No spans match. Try a tool name (<span className="font-mono">Bash</span>), a file path, or an error message.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-6">
          {(spans ?? []).map((s) => (
            <button
              key={s.spanId}
              type="button"
              onClick={() => onOpen(s.traceId, s.spanId)}
              className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
            >
              <StatusDot status={s.status} running={isRunning(s)} />
              <SpanKindToken kind={s.kind} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                {/* The matched context, not just the name — otherwise 40 rows called "tool Bash" are
                    indistinguishable and you have to open every one. */}
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {String(s.attributes?.output ?? s.attributes?.input ?? '').slice(0, 160) || (s.attributes?.['cascade.project_id'] ? (names.get(String(s.attributes['cascade.project_id'])) ?? '') : '')}
                </span>
              </span>
              <span className="justify-self-end font-mono text-xs text-muted-foreground">{isRunning(s) ? '…' : formatDuration(durationOf(s))}</span>
              <span className="justify-self-end text-xs text-muted-foreground">{formatTimeAgo(s.startedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Conversations, not turns — the DEFAULT view.
 *
 * A trace is one turn (Phoenix, LangSmith and Langfuse all model it that way, and so do we), which means
 * building one app produces dozens of traces. A flat list of them answers "what happened in some turn"
 * while burying "what did this build do", and the second question is the one you actually arrive with.
 * All three of those tools solve it with a grouping layer keyed on a session id; this is ours, and it
 * leads because for Cascade the conversation IS the unit of work.
 */
function SessionList({ sessions, loaded, names, onOpen }: { sessions: SessionInfo[]; loaded: boolean; names: Map<string, string>; onOpen: (chatId: string) => void }) {
  if (!loaded)
    return (
      <div className="space-y-2 p-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-md bg-muted/50" />
        ))}
      </div>
    )

  if (!sessions.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <MessagesSquare className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No conversations recorded yet.</p>
        <p className="max-w-md text-xs text-muted-foreground/70">
          Each chat with a project becomes one conversation here, with every turn it took inside it. Turns recorded before conversation tracking existed appear under <span className="font-medium">All turns</span>.
        </p>
      </div>
    )

  return (
    // ADR-084 Phase 4: cap the MEASURE. Unconstrained, each row ran the full window — ~250 characters on a
    // 2560px display against a 65–75 optimum — so the eye had to cross the whole screen to get from the
    // prompt to its timestamp, and the metadata that actually distinguishes one row from another sat a
    // screen-width away from the title it belongs to. Left-aligned, not centred: it stays anchored to the
    // tabs above it.
    <div className="min-h-0 max-w-5xl flex-1 overflow-auto px-3 pb-6">
      {sessions.map((s) => (
        <button
          key={s.chatId}
          type="button"
          onClick={() => onOpen(s.chatId)}
          className="flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors hover:bg-accent"
        >
          <StatusDot status={s.errorTurns ? 'error' : 'ok'} running={s.running} size={9} />
          <span className="min-w-0 flex-1">
            {/* The opening PROMPT is the title. An id identifies nothing to a human, and "agent (builder)"
                is the same on every row — what you remember is what you asked for. */}
            <span className="block truncate text-sm font-medium">{s.firstPrompt || '(no prompt recorded)'}</span>
            {s.lastOutput && <span className="mt-0.5 block truncate text-xs text-muted-foreground">→ {s.lastOutput}</span>}
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {s.projectId && <span className="font-medium">{names.get(s.projectId) ?? 'unknown project'}</span>}
              <span>
                {s.turnCount} turn{s.turnCount === 1 ? '' : 's'}
              </span>
              {s.errorTurns > 0 && <span className="text-danger">{s.errorTurns} failed</span>}
              <span className="font-mono">{formatDuration(s.endedAt - s.startedAt)}</span>
              {s.outputTokens > 0 && <span className="font-mono">{formatTokens(s.outputTokens)} out</span>}
              {s.models.length > 0 && <span className="truncate font-mono">{s.models.join(', ')}</span>}
            </span>
          </span>
          <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{formatTimeAgo(s.endedAt)}</span>
        </button>
      ))}
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

  if (!traces.length) return <EmptyList />

  return <TraceRows traces={traces} names={names} onOpen={onOpen} />
}

/** "Nothing recorded" and "nothing MATCHES" are different facts, and telling a user the first when the
 *  second is true reads as data loss. The filter state decides which one this is. */
function EmptyList() {
  const { traceFilter, setTraceFilter } = useStore()
  const filtered = Boolean(traceFilter.q || traceFilter.status || traceFilter.projectId || traceFilter.model)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Radar className="h-8 w-8 text-muted-foreground/40" />
      {filtered ? (
        <>
          <p className="text-sm text-muted-foreground">No turns match these filters.</p>
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setTraceFilter({ q: undefined, status: undefined, projectId: undefined, model: undefined })}>
            <X className="mr-1 h-3.5 w-3.5" /> Clear filters
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">No traces yet.</p>
          <p className="max-w-sm text-xs text-muted-foreground/70">Every message you send a project is recorded here — the model calls it made, the tools it ran, and how long each took.</p>
        </>
      )}
    </div>
  )
}

function TraceRows({ traces, names, onOpen }: { traces: TraceSummaryInfo[]; names: Map<string, string>; onOpen: (id: string) => void }) {
  const { tracesExhausted, loadMoreTraces } = useStore()

  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-6">
      {/* A grid, not a table: the columns must stay aligned while each row is a single click target. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-4 px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground">
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
            {/* The PROMPT leads, the agent label follows. Every root is called "agent (builder)", so a
                list titled by name is a column of identical rows — which is exactly what made the flat
                view unreadable in the first place. */}
            <span className="block truncate text-sm font-medium">{t.prompt || t.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {t.prompt ? `${t.name}${t.projectId ? ' · ' : ''}` : ''}
              {t.projectId ? (names.get(t.projectId) ?? 'unknown project') : ''}
            </span>
          </span>
          <span className="justify-self-end font-mono text-xs text-muted-foreground">{t.spanCount}</span>
          {/* A running turn has no total yet — showing the closed spans' extent would read as a fast turn. */}
          <span className={cn('justify-self-end font-mono text-xs', t.running && 'text-blue-500')}>{t.running ? 'running…' : formatDuration(t.durationMs)}</span>
          <span className="max-w-[10rem] justify-self-end truncate font-mono text-xs text-muted-foreground">{t.model ?? '—'}</span>
          <span className="justify-self-end text-xs text-muted-foreground">{formatTimeAgo(t.startedAt)}</span>
        </button>
      ))}
      {/* Explicit, not infinite-scroll: the list polls every 3s, and a scroll-triggered fetch racing a
          poll is how duplicate and skipped rows happen. One button, one page. */}
      {!tracesExhausted && (
        <div className="px-3 pt-3">
          <Button variant="outline" size="sm" className="w-full" onClick={loadMoreTraces}>
            Load older turns
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Rebuild the headline from the SPANS when the summary row isn't loaded — which is the normal case for a
 * shared/bookmarked `/observatory/<id>` URL, and for a jump out of span search (where the trace list was
 * never fetched). Without it the header read "Trace · duration —" with no name and no chat link, i.e. the
 * deep link worked and then landed you somewhere anonymous.
 */
function summaryFromSpans(traceId: string, spans: SpanInfo[]): TraceSummaryInfo {
  const root = spans.find((s) => !s.parentSpanId) ?? spans[0]
  const { ms } = traceWindow(spans)
  return {
    traceId,
    name: root?.name ?? 'Trace',
    startedAt: root?.startedAt ?? 0,
    durationMs: spans.some(isRunning) ? undefined : ms,
    spanCount: spans.length,
    status: spans.some((s) => s.status === 'error') ? 'error' : 'ok',
    running: spans.some(isRunning),
    projectId: root?.attributes?.['cascade.project_id'] as string | undefined,
    model: root?.attributes?.['cascade.model'] as string | undefined,
    chatId: root?.attributes?.['cascade.chat_id'] as string | undefined,
  }
}

function TraceDetail({ trace, spans, onBack }: { trace: TraceSummaryInfo | undefined; spans: SpanInfo[] | undefined; onBack: () => void }) {
  const selectedSpanId = useStore((s) => s.selectedSpanId)
  const selectSpan = useStore((s) => s.selectSpan)
  const spanDetails = useStore((s) => s.spanDetails)
  const openChat = useStore((s) => s.openChat)

  // Land on the root span rather than an empty panel — for most turns the root IS the summary you want.
  useEffect(() => {
    if (!selectedSpanId && spans?.length) selectSpan((spans.find((s) => !s.parentSpanId) ?? spans[0]).spanId)
  }, [spans, selectedSpanId, selectSpan])

  // Prefer the untrimmed copy. The tree's spans have their payloads shortened for transport, so showing
  // one directly would silently present a cut prompt as the whole thing.
  const fromTree = spans?.find((s) => s.spanId === selectedSpanId) ?? null
  const selected = (selectedSpanId ? spanDetails[selectedSpanId] : null) ?? fromTree
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
          {/* A trace is a TURN, and a turn came from a conversation. Without this the Observatory is a
              dead end: you diagnose the failure and then have to hunt for the chat by hand. */}
          {trace?.projectId && trace.chatId && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => openChat(trace.projectId!, trace.chatId!)}>
              <MessagesSquare className="mr-1.5 h-3.5 w-3.5" /> Open chat
            </Button>
          )}
        </div>
      </div>

      {spans ? (
        // Fixed left column rather than a resizable split: we have no resizable primitive, and a 2-pane
        // layout with one scrollable side is exactly what this view needs. Both panes scroll internally so
        // the page itself never does.
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(26rem,40%)_1fr]">
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
  const { traces, tracesLoaded, openTraceId, traceSpans, projects, spanSearch, spanResults, requestTraces, openTrace, closeTrace, selectSpan } = useStore()
  const { observatoryView, sessions, sessionsLoaded, openSessionId, requestSessions, openSession } = useStore()

  // Poll while mounted. Re-requesting the OPEN trace too keeps a live turn's waterfall growing on screen;
  // both requests are cheap reads against a local DB, and the interval dies with the page.
  //
  // The poll is SUSPENDED while a span search is showing: a search is a considered question with a stable
  // answer, and having its results reshuffle under the cursor every 3s makes it unusable.
  useEffect(() => {
    const tick = () => {
      const s = useStore.getState()
      if (s.spanSearch) return
      if (s.observatoryView === 'sessions' && !s.openSessionId) s.requestSessions()
      else s.requestTraces()
      if (s.openTraceId) s.send({ type: 'trace', action: 'spans', traceId: s.openTraceId })
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [])

  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const openTraceSummary = traces.find((t) => t.traceId === openTraceId)

  if (openTraceId) {
    const loaded = traceSpans[openTraceId]
    // Prefer the list row (it aggregates server-side), fall back to the spans we already hold.
    const summary = openTraceSummary ?? (loaded?.length ? summaryFromSpans(openTraceId, loaded) : undefined)
    return <TraceDetail trace={summary} spans={loaded} onBack={closeTrace} />
  }

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
        <Button variant="ghost" size="icon-sm" onClick={() => (observatoryView === 'sessions' && !openSessionId ? requestSessions() : requestTraces())} title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <FilterBar projects={projects} />
      {openSessionId && (
        // Drilled into one conversation. A back affordance, plus the prompt that opened it, so the turn
        // list underneath has a subject rather than being 12 rows all called "agent (builder)".
        <div className="flex items-center gap-2 border-b bg-muted/30 px-6 py-2">
          <Button variant="ghost" size="icon-sm" onClick={() => openSession(null)} title="Back to conversations">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="text-muted-foreground">Conversation · </span>
            {sessions.find((s) => s.chatId === openSessionId)?.firstPrompt ?? openSessionId}
          </span>
        </div>
      )}
      {observatoryView === 'sessions' && !openSessionId ? (
        <SessionList sessions={sessions} loaded={sessionsLoaded} names={names} onOpen={openSession} />
      ) : spanSearch ? (
        <SpanResults
          spans={spanResults}
          names={names}
          onOpen={(traceId, spanId) => {
            // Jump from a search hit INTO its trace with that span selected — the result is a pointer to
            // a moment, and landing on the trace root would make you hunt for it a second time.
            openTrace(traceId)
            selectSpan(spanId)
          }}
        />
      ) : (
        <>
          <StatsBar traces={traces} />
          <TraceList traces={traces} loaded={tracesLoaded} names={names} onOpen={openTrace} />
        </>
      )}
    </div>
  )
}
