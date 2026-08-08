// db.ts — the embedded SQLite bootstrap (ADR-081 §1, §3).
//
// Driver is `node:sqlite`, chosen over better-sqlite3 after a measured spike: it is BUILT IN to Node
// 22.5+ (which Electron ships), so there is no native module to rebuild per platform, no prebuild
// matrix, and nothing to unpack outside `asar` — the single most common way an Electron app works in
// dev and breaks when packaged. It is still flagged experimental; if that bites, swapping to
// better-sqlite3 touches this file only, because everything above talks to the @cascade/storage ports.
//
// Spike (2026-07-26, this machine): 5000 inserts inside ONE transaction = 4ms (~1.25M rows/sec). Our
// measured load is hundreds of rows over MINUTES, which is why ADR-081 rejects a queue system.

// The reference is load-bearing, not decorative: consumers (packages/server) compile this file as part of
// THEIR program via the workspace `exports` → src mapping, and an ambient .d.ts that is merely sitting in
// this directory is not in that program. Referencing it here makes the declaration travel with the import.
/// <reference path="./node-sqlite.d.ts" />
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

/** Ordered, append-only. NEVER edit a shipped entry — add a new one; installs migrate forward in place. */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001-init',
    sql: `
      CREATE TABLE IF NOT EXISTS spans (
        trace_id     TEXT NOT NULL,
        span_id      TEXT NOT NULL PRIMARY KEY,
        parent_id    TEXT,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        status       TEXT,
        project_id   TEXT,
        model        TEXT,
        attributes   TEXT
      );
      -- The Observatory's two access paths: newest-traces-first, and every span of one trace.
      CREATE INDEX IF NOT EXISTS spans_trace       ON spans(trace_id);
      CREATE INDEX IF NOT EXISTS spans_started     ON spans(started_at DESC);
      CREATE INDEX IF NOT EXISTS spans_project     ON spans(project_id, started_at DESC);
    `,
  },
  {
    // Lifted out of the attributes JSON for the same reason project_id and model were: the Observatory
    // links a trace back to the conversation that produced it, and JSON extraction cannot use an index.
    id: '002-chat-id',
    sql: `
      ALTER TABLE spans ADD COLUMN chat_id TEXT;
      CREATE INDEX IF NOT EXISTS spans_chat ON spans(chat_id, started_at DESC);
    `,
  },
  {
    // Models, connectors and settings (ADR-081 §2). One JSON document per key — see configStore.ts for
    // why documents rather than a table per concept.
    id: '003-config',
    sql: `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  },
]

/**
 * Open (creating if absent) and migrate IN-PROCESS. A shipped binary has no operator to run a
 * migration step, so launch is the only safe moment — and a half-migrated install is a support ticket
 * we cannot debug remotely, hence the whole batch runs inside one transaction.
 */
export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  // WAL is for CONCURRENCY, not throughput (ADR-081 §3): it lets the Observatory read traces while a
  // turn is still writing them. NORMAL drops the fsync-per-commit stall; with WAL the worst case on
  // power loss is losing the last transaction, which for telemetry and replay logs is acceptable.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')

  const done = new Set((db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map((r) => r.id))
  const pending = MIGRATIONS.filter((m) => !done.has(m.id))
  if (pending.length) {
    db.exec('BEGIN')
    try {
      const mark = db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)')
      for (const m of pending) {
        db.exec(m.sql)
        mark.run(m.id, Date.now())
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK') // all-or-nothing: never leave an install half-migrated
      throw e
    }
  }
  return db
}

/**
 * Batches rows and flushes them inside ONE transaction. The cost in SQLite is the commit/fsync, not
 * the insert, so 500 individual commits are ~100× the work of one 500-row commit.
 *
 * `push` is deliberately synchronous and returns void: callers are on the agent's hot path
 * (`tracer.event(...)` is fire-and-forget) and must never await storage.
 */
export class BufferedWriter<T> {
  private buf: T[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flushFn: (rows: T[]) => void,
    private readonly maxRows = 100,
    private readonly maxDelayMs = 150,
  ) {}

  push(row: T): void {
    this.buf.push(row)
    if (this.buf.length >= this.maxRows) {
      this.flush()
      return
    }
    // Re-arming on every row would starve a steady stream; arm ONCE per batch so the oldest row is
    // never held longer than maxDelayMs.
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.maxDelayMs)
      this.timer.unref?.() // a pending flush must not keep the process alive
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buf.length) return
    const rows = this.buf
    this.buf = []
    // Telemetry must never take the app down: a failed flush drops the batch and keeps serving.
    try {
      this.flushFn(rows)
    } catch {
      /* dropped */
    }
  }
}
