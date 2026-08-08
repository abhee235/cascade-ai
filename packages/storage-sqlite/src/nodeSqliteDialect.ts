// nodeSqliteDialect.ts — Kysely over Node's BUILT-IN sqlite (ADR-081, amended 2026-08-08).
//
// Kysely ships a SqliteDialect, but it is built on better-sqlite3 — a native module. Using it would undo
// the reason `node:sqlite` was chosen in the first place: it is part of Node 22.5+ (which Electron ships),
// so there is no per-platform prebuild matrix and nothing to unpack outside `asar`. That property is what
// makes the desktop build boring, and it is not worth trading for a dependency we can replace in 60 lines.
//
// Only the DRIVER is ours. The adapter, query compiler and introspector are Kysely's own SQLite ones, so
// the SQL this produces is exactly what any other Kysely SQLite user gets — and swapping the whole dialect
// for PostgresDialect or MssqlDialect changes this file and nothing above it.

import { CompiledQuery, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, type DatabaseConnection, type DatabaseIntrospector, type Dialect, type DialectAdapter, type Driver, type Kysely, type QueryCompiler, type QueryResult } from 'kysely'
import type { Db } from './db.js'

/** node:sqlite is SYNCHRONOUS, so a connection is just the handle. SQLite allows one writer at a time
 *  anyway, so a pool would be ceremony around a mutex we do not need. */
class NodeSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: Db) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const stmt = this.db.prepare(compiled.sql)
    const params = compiled.parameters as unknown[]
    // SELECT returns rows; INSERT/UPDATE/DELETE/DDL report affected rows. Kysely tells them apart by
    // which fields come back, so returning the wrong shape breaks `executeTakeFirst` in silent ways.
    if (/^\s*(select|with|pragma)/i.test(compiled.sql)) return { rows: stmt.all(...params) as R[] }
    const { changes, lastInsertRowid } = stmt.run(...params)
    return {
      rows: [],
      numAffectedRows: BigInt(changes ?? 0),
      insertId: lastInsertRowid === undefined ? undefined : BigInt(lastInsertRowid),
    }
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    // node:sqlite has an iterator API, but nothing here streams: the largest read is one trace's spans.
    // Throwing is better than a fake stream that silently buffers everything.
    throw new Error('streaming is not implemented for the node:sqlite dialect')
  }
}

class NodeSqliteDriver implements Driver {
  private connection?: NodeSqliteConnection
  constructor(private readonly db: Db) {}

  async init(): Promise<void> {
    this.connection = new NodeSqliteConnection(this.db)
  }
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection!
  }
  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('BEGIN'))
  }
  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('COMMIT'))
  }
  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('ROLLBACK'))
  }
  async releaseConnection(): Promise<void> {
    /* single shared handle — nothing to return to a pool */
  }
  async destroy(): Promise<void> {
    /* the DB handle is owned by openDb, which closes it on dispose */
  }
}

/** A Kysely dialect backed by an already-open `node:sqlite` handle. */
export class NodeSqliteDialect implements Dialect {
  constructor(private readonly db: Db) {}
  createAdapter(): DialectAdapter {
    return new SqliteAdapter()
  }
  createDriver(): Driver {
    return new NodeSqliteDriver(this.db)
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }
  // biome-ignore lint/suspicious/noExplicitAny: Kysely's own signature
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}
