// traceStore.ts — SQLite-backed TraceStore (ADR-081 §5).
//
// Traces stopped being dev tooling this cycle: nearly every weak-model failure was diagnosed by
// reading one (the 114-turn thrash, the narration loop, the silent 8k window). That makes an in-app
// Observatory a product feature — and it needs a queryable store, not a JSONL file the UI has to
// parse. This is that store; the JSONL and OTLP tracers stay as-is and fan out alongside it.

import type { SpanRecord, TraceStore, TraceSummary } from '@cascade/storage'
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
  attributes: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))

export function createTraceStore(db: Db): TraceStore {
  // A span is written ONCE, when it ends — but the same span_id can arrive twice if a tracer re-emits
  // after a retry, so upsert rather than insert to keep the write idempotent.
  const insert = db.prepare(`
    INSERT INTO spans (trace_id, span_id, parent_id, name, kind, started_at, ended_at, status, project_id, model, attributes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(span_id) DO UPDATE SET
      ended_at = excluded.ended_at, status = excluded.status, attributes = excluded.attributes
  `)

  const writer = new BufferedWriter<SpanRow>((rows) => {
    db.exec('BEGIN')
    try {
      for (const r of rows) {
        insert.run(r.trace_id, r.span_id, r.parent_id, r.name, r.kind, r.started_at, r.ended_at, r.status, r.project_id, r.model, r.attributes)
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
        attributes: Object.keys(a).length ? JSON.stringify(a) : null,
      })
    },

    async listTraces(opts): Promise<TraceSummary[]> {
      writer.flush() // the newest trace is usually still buffered — the list must not lag the UI
      const where: string[] = []
      const params: unknown[] = []
      if (opts?.projectId) {
        where.push('project_id = ?')
        params.push(opts.projectId)
      }
      if (opts?.before) {
        where.push('started_at < ?')
        params.push(opts.before)
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
                 MAX(CASE WHEN status = 'error' THEN 1 ELSE 0 END)  AS has_error,
                 MAX(project_id)                                    AS project_id,
                 MAX(model)                                         AS model
          FROM spans
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          GROUP BY trace_id
          ORDER BY started_at DESC
          LIMIT ?
        `)
        .all(...(params as never[])) as Record<string, unknown>[]

      return rows.map((r) => ({
        traceId: r.trace_id as string,
        name: (r.root_name as string) ?? '(trace)',
        startedAt: r.started_at as number,
        durationMs: Math.max(0, (r.ended_at as number) - (r.started_at as number)),
        spanCount: r.span_count as number,
        status: r.has_error ? 'error' : 'ok',
        projectId: (r.project_id as string) ?? undefined,
        model: (r.model as string) ?? undefined,
      }))
    },

    async spans(traceId: string): Promise<SpanRecord[]> {
      writer.flush() // a LIVE trace is mid-write; without this the waterfall stops short of "now"
      const rows = db.prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at ASC').all(traceId) as unknown as SpanRow[]
      return rows.map((r) => ({
        traceId: r.trace_id,
        spanId: r.span_id,
        parentSpanId: r.parent_id ?? undefined,
        name: r.name,
        kind: r.kind,
        startedAt: r.started_at,
        endedAt: r.ended_at ?? undefined,
        status: (r.status as 'ok' | 'error' | null) ?? undefined,
        attributes: r.attributes ? (JSON.parse(r.attributes) as Record<string, unknown>) : undefined,
      }))
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
