// traceStore.ts — SQLite-backed TraceStore (ADR-081 §5).
//
// Traces stopped being dev tooling this cycle: nearly every weak-model failure was diagnosed by
// reading one (the 114-turn thrash, the narration loop, the silent 8k window). That makes an in-app
// Observatory a product feature — and it needs a queryable store, not a JSONL file the UI has to
// parse. This is that store; the JSONL and OTLP tracers stay as-is and fan out alongside it.

import type { SessionSummary, SpanRecord, TraceStore, TraceSummary } from '@cascade/storage'
import { BufferedWriter, type Db } from './db.js'

/** The DB row shape. `attributes` is JSON; project/model are lifted OUT of it into real columns
 *  because the Observatory filters and groups on them, and JSON extraction can't use an index. */
interface SpanRow {
  trace_id: string
  span_id: string
  parent_id: string | null
  name: string
  kind: string
  started_at: number
  ended_at: number | null
  status: string | null
  project_id: string | null
  model: string | null
  chat_id: string | null
  attributes: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))

/** Row → port shape. Shared by every read path, so a column added here surfaces everywhere at once. */
const toSpan = (r: SpanRow): SpanRecord => ({
  traceId: r.trace_id,
  spanId: r.span_id,
  parentSpanId: r.parent_id ?? undefined,
  name: r.name,
  kind: r.kind,
  startedAt: r.started_at,
  endedAt: r.ended_at ?? undefined,
  status: (r.status as 'ok' | 'error' | null) ?? undefined,
  attributes: r.attributes ? (JSON.parse(r.attributes) as Record<string, unknown>) : undefined,
})

export function createTraceStore(db: Db): TraceStore {
  // A span is written ONCE, when it ends — but the same span_id can arrive twice if a tracer re-emits
  // after a retry, so upsert rather than insert to keep the write idempotent.
  const insert = db.prepare(`
    INSERT INTO spans (trace_id, span_id, parent_id, name, kind, started_at, ended_at, status, project_id, model, chat_id, attributes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(span_id) DO UPDATE SET
      ended_at = excluded.ended_at, status = excluded.status, attributes = excluded.attributes
  `)

  const writer = new BufferedWriter<SpanRow>((rows) => {
    db.exec('BEGIN')
    try {
      for (const r of rows) {
        insert.run(r.trace_id, r.span_id, r.parent_id, r.name, r.kind, r.started_at, r.ended_at, r.status, r.project_id, r.model, r.chat_id, r.attributes)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })

  return {
    record(span: SpanRecord): void {
      const a = span.attributes ?? {}
      writer.push({
        trace_id: span.traceId,
        span_id: span.spanId,
        parent_id: span.parentSpanId ?? null,
        name: span.name,
        kind: span.kind,
        started_at: span.startedAt,
        ended_at: span.endedAt ?? null,
        status: span.status ?? null,
        project_id: str(a['cascade.project_id'] ?? a.projectId),
        model: str(a['llm.model_name'] ?? a['cascade.model'] ?? a.model),
        chat_id: str(a['cascade.chat_id'] ?? a['session.id']),
        attributes: Object.keys(a).length ? JSON.stringify(a) : null,
      })
    },

    async listTraces(opts): Promise<TraceSummary[]> {
      writer.flush() // the newest trace is usually still buffered — the list must not lag the UI
      // Only project_id belongs in WHERE. Everything else filters a TRACE, and a trace is an aggregate:
      // putting `started_at < before` in WHERE (as this first did) drops the late spans of an otherwise
      // included trace, so its span count and duration come back wrong. HAVING filters whole groups.
      const where: string[] = []
      const having: string[] = []
      const params: unknown[] = []
      if (opts?.projectId) {
        where.push('project_id = ?')
        params.push(opts.projectId)
      }
      if (opts?.chatId) {
        where.push('chat_id = ?')
        params.push(opts.chatId)
      }
      if (opts?.before) {
        // Keyset cursor with a tie-breaker. `MIN(started_at) < ?` alone drops every trace that shares the
        // boundary millisecond — measured: 150 traces paged out as 136, silently. The ORDER BY below sorts
        // on the same pair, so the comparison and the ordering agree and no row can be skipped or repeated.
        if (opts.beforeId) {
          having.push('(MIN(started_at) < ? OR (MIN(started_at) = ? AND trace_id < ?))')
          params.push(opts.before, opts.before, opts.beforeId)
        } else {
          having.push('MIN(started_at) < ?')
          params.push(opts.before)
        }
      }
      if (opts?.status === 'error') having.push('has_error = 1')
      if (opts?.status === 'ok') having.push('has_error = 0')
      if (opts?.model) {
        having.push('MAX(model) = ?')
        params.push(opts.model)
      }
      if (opts?.q?.trim()) {
        // Search the ROOT span: its name is the agent label and its `input` attribute is the user's own
        // prompt — "which turn was the one where I asked about favourites?" is how you actually look.
        having.push("MAX(CASE WHEN parent_id IS NULL THEN name || ' ' || COALESCE(attributes, '') END) LIKE ?")
        params.push(`%${opts.q.trim()}%`)
      }
      params.push(opts?.limit ?? 50)
      // One row per trace: the ROOT span names it (parent_id IS NULL); the aggregate gives span count
      // and true wall span, since a root may commit before late children on some tracers.
      const rows = db
        .prepare(`
          SELECT trace_id,
                 MIN(started_at)                                    AS started_at,
                 MAX(COALESCE(ended_at, started_at))                AS ended_at,
                 COUNT(*)                                           AS span_count,
                 MAX(CASE WHEN parent_id IS NULL THEN name END)     AS root_name,
                 MAX(CASE WHEN parent_id IS NULL THEN json_extract(attributes, '$.input') END) AS prompt,
                 MAX(CASE WHEN status = 'error' THEN 1 ELSE 0 END)  AS has_error,
                 MAX(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END)  AS has_open,
                 MAX(project_id)                                    AS project_id,
                 MAX(model)                                         AS model,
                 MAX(chat_id)                                       AS chat_id
          FROM spans
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          GROUP BY trace_id
          ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
          ORDER BY started_at DESC, trace_id DESC
          LIMIT ?
        `)
        .all(...(params as never[])) as Record<string, unknown>[]

      return rows.map((r) => ({
        traceId: r.trace_id as string,
        name: (r.root_name as string) ?? '(trace)',
        prompt: (r.prompt as string) ?? undefined,
        startedAt: r.started_at as number,
        // A running trace has NO duration: MAX(COALESCE(ended_at, started_at)) over open spans measures
        // only the part that already closed, which reads as a fast turn when it is in fact an unfinished
        // one. Undefined is the honest answer; the UI shows it as running.
        durationMs: r.has_open ? undefined : Math.max(0, (r.ended_at as number) - (r.started_at as number)),
        spanCount: r.span_count as number,
        status: r.has_error ? 'error' : 'ok',
        running: !!r.has_open,
        projectId: (r.project_id as string) ?? undefined,
        model: (r.model as string) ?? undefined,
        chatId: (r.chat_id as string) ?? undefined,
      }))
    },

    async listSessions(opts): Promise<SessionSummary[]> {
      writer.flush()
      const where = ['chat_id IS NOT NULL']
      const params: unknown[] = []
      if (opts?.projectId) {
        where.push('project_id = ?')
        params.push(opts.projectId)
      }
      const limit = opts?.limit ?? 50

      // The aggregate. errorTurns counts distinct TRACES containing a failure, not failed spans — "3 of
      // 12 turns went wrong" is the useful number; "9 failed spans" is not, since one bad turn can
      // produce several.
      const rows = db
        .prepare(`
          SELECT chat_id,
                 MAX(project_id)                                     AS project_id,
                 COUNT(DISTINCT trace_id)                            AS turn_count,
                 COUNT(DISTINCT CASE WHEN status = 'error' THEN trace_id END) AS error_turns,
                 MIN(started_at)                                     AS started_at,
                 MAX(COALESCE(ended_at, started_at))                 AS ended_at,
                 MAX(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END)   AS has_open
          FROM spans
          WHERE ${where.join(' AND ')}
          GROUP BY chat_id
          ORDER BY MAX(COALESCE(ended_at, started_at)) DESC
          LIMIT ?
        `)
        .all(...([...params, limit] as never[])) as Record<string, unknown>[]
      if (!rows.length) return []

      const ids = rows.map((r) => r.chat_id as string)
      const slots = ids.map(() => '?').join(',')

      // First prompt and last output, two rows per session rather than every root span, via window
      // functions. Fetching all roots and reducing in JS would pull one row per TURN — fine at 20 turns,
      // wasteful at 500, and this list is the landing page.
      const edges = db
        .prepare(`
          SELECT chat_id, kind, attributes, rn_first, rn_last FROM (
            SELECT chat_id, kind, attributes,
                   -- rowid breaks ties, and ties are the common case: turns inside one conversation can
                   -- share a millisecond, and started_at alone then lets SQLite pick arbitrarily — which
                   -- showed turn 5 of 6 as a conversation's "last output". rowid is insertion order,
                   -- i.e. emission order, which is exactly the sequence we mean by first and last.
                   ROW_NUMBER() OVER (PARTITION BY chat_id, kind ORDER BY started_at ASC,  rowid ASC)  AS rn_first,
                   ROW_NUMBER() OVER (PARTITION BY chat_id, kind ORDER BY started_at DESC, rowid DESC) AS rn_last
            FROM spans
            WHERE chat_id IN (${slots}) AND kind IN ('AGENT', 'LLM') AND attributes IS NOT NULL
          ) WHERE rn_first = 1 OR rn_last = 1
        `)
        .all(...(ids as never[])) as Record<string, unknown>[]

      const first = new Map<string, string>()
      const last = new Map<string, string>()
      for (const e of edges) {
        const a = JSON.parse((e.attributes as string) ?? '{}') as Record<string, unknown>
        // The opening PROMPT is the earliest AGENT root's input; the closing answer is the latest LLM
        // span's output (the root carries no output — it is a container).
        if (e.kind === 'AGENT' && e.rn_first === 1 && typeof a.input === 'string') first.set(e.chat_id as string, a.input)
        if (e.kind === 'LLM' && e.rn_last === 1 && typeof a.output === 'string') last.set(e.chat_id as string, a.output)
      }

      // Models + output tokens per session. Separate because both need to scan LLM spans, and folding
      // them into the aggregate above would force that scan for sessions we then discard by LIMIT.
      const stats = db
        .prepare(`
          SELECT chat_id, model, COUNT(*) AS n, SUM(COALESCE(json_extract(attributes, '$.outputTokens'), 0)) AS out_tokens
          FROM spans WHERE chat_id IN (${slots}) AND kind = 'LLM'
          GROUP BY chat_id, model ORDER BY n DESC
        `)
        .all(...(ids as never[])) as Record<string, unknown>[]
      const models = new Map<string, string[]>()
      const tokens = new Map<string, number>()
      for (const s of stats) {
        const id = s.chat_id as string
        if (s.model) models.set(id, [...(models.get(id) ?? []), s.model as string])
        tokens.set(id, (tokens.get(id) ?? 0) + Number(s.out_tokens ?? 0))
      }

      return rows.map((r) => {
        const id = r.chat_id as string
        return {
          chatId: id,
          projectId: (r.project_id as string) ?? undefined,
          firstPrompt: first.get(id),
          lastOutput: last.get(id),
          turnCount: r.turn_count as number,
          startedAt: r.started_at as number,
          endedAt: r.ended_at as number,
          errorTurns: r.error_turns as number,
          outputTokens: tokens.get(id) ?? 0,
          models: models.get(id) ?? [],
          running: !!r.has_open,
        }
      })
    },

    async spans(traceId: string): Promise<SpanRecord[]> {
      writer.flush() // a LIVE trace is mid-write; without this the waterfall stops short of "now"
      const rows = db.prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at ASC').all(traceId) as unknown as SpanRow[]
      return rows.map(toSpan)
    },

    async searchSpans(opts): Promise<SpanRecord[]> {
      writer.flush()
      const where: string[] = []
      const params: unknown[] = []
      if (opts?.projectId) {
        where.push('project_id = ?')
        params.push(opts.projectId)
      }
      if (opts?.kind) {
        where.push('kind = ?')
        params.push(opts.kind)
      }
      if (opts?.status) {
        where.push('status = ?')
        params.push(opts.status)
      }
      if (opts?.q?.trim()) {
        // Name OR attributes: the name finds "tool Bash", the attributes find the file path in its input
        // or the error text in its output. One box, because a user hunting a failure does not yet know
        // which of those their memory of it lives in.
        where.push("(name LIKE ? OR COALESCE(attributes, '') LIKE ?)")
        params.push(`%${opts.q.trim()}%`, `%${opts.q.trim()}%`)
      }
      params.push(opts?.limit ?? 200)
      const rows = db
        .prepare(`SELECT * FROM spans ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`)
        .all(...(params as never[])) as unknown as SpanRow[]
      return rows.map(toSpan)
    },

    async models(): Promise<string[]> {
      writer.flush()
      // Ordered by most-recently-used, so the filter's first option is the model you are working with.
      const rows = db.prepare('SELECT model, MAX(started_at) AS last FROM spans WHERE model IS NOT NULL GROUP BY model ORDER BY last DESC').all() as { model: string }[]
      return rows.map((r) => r.model)
    },

    async prune(olderThanMs: number): Promise<number> {
      // A desktop install runs for months; without retention the DB grows without bound.
      // Flush FIRST: buffered spans are not in the table yet, so counting before/after without this
      // reports 0 deleted and silently leaves the newest batch unpruned (caught by test).
      writer.flush()
      const cutoff = Date.now() - olderThanMs
      const before = (db.prepare('SELECT COUNT(*) AS c FROM spans').get() as { c: number }).c
      db.prepare('DELETE FROM spans WHERE started_at < ?').run(cutoff)
      const after = (db.prepare('SELECT COUNT(*) AS c FROM spans').get() as { c: number }).c
      return before - after
    },

    async flush(): Promise<void> {
      writer.flush()
    },
  }
}
