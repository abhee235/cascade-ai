// @cascade/storage-sqlite — the DESKTOP adapter for @cascade/storage (ADR-081).
// Embedded SQLite via node:sqlite: zero native dependencies, WAL, in-process migrations, buffered
// writes. Swapping this for @cascade/storage-postgres must require no change in packages/server.
export { openDb, BufferedWriter, type Db } from './db.js'
export { createTraceStore } from './traceStore.js'
export { createSqliteTracer, type SqliteTracerOptions, type TracerLike } from './sqliteTracer.js'
