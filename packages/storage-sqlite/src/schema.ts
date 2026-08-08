// schema.ts — the database shape, as Kysely types it.
//
// Hand-written rather than generated: two tables, and a codegen step in the build is a cost you pay
// forever to avoid typing thirteen fields once. It IS the contract though — Kysely checks every query
// against it, so a column rename fails at compile time instead of at 2am.

export interface SpansTable {
  /** Monotonic insert order. Replaces a reliance on SQLite's implicit `rowid`, which does not exist in
   *  Postgres or SQL Server — the one genuinely non-portable thing the schema had. It is load-bearing,
   *  not decorative: turns inside a conversation routinely share a millisecond, so `started_at` alone
   *  cannot say which model call came first, and "last output" picked an arbitrary one. */
  seq: number
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

export interface ConfigTable {
  key: string
  value: string
}

export interface Database {
  spans: SpansTable
  config: ConfigTable
}
