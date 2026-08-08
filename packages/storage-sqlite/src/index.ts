// @cascade/storage-sqlite — the DESKTOP adapter for @cascade/storage (ADR-081).
// Embedded SQLite via node:sqlite: zero native dependencies, WAL, in-process migrations, buffered
// writes. Swapping this for @cascade/storage-postgres must require no change in packages/server.
//
// Note what is NOT here: any knowledge of the agent's event stream. This package used to carry its own
// event→span fold, which drifted from the OTLP one (ADR-081 amendment). The fold now lives in core and
// this adapter is a pure sink — `storage.traces.record` IS the sink, so nothing needs to be exported for
// it. That leaves the adapter with exactly one job: rows in, rows out.
export { openDb, BufferedWriter, type Db } from './db.js'
export { createTraceStore } from './traceStore.js'
export { createTelemetryStorage, type TelemetryStorage, type CreateStorageOptions } from './createStorage.js'
export { createConfigStore } from './configStore.js'
export { createChatStore, newChatId } from './chatStore.js'
// Exported so the ENTRY POINT can run it once at startup: it needs the legacy projects root, which the
// composition root knows and this package does not.
export { importLegacyConfig, importLegacyChats, chatsImported, markChatsImported } from './importLegacy.js'
