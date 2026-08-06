// main.ts — the DESKTOP composition root (ADR-081 §6). The process entry point.
//
// This is the ONLY file in packages/server allowed to name a storage backend. Everything else receives
// stores and factories by injection, which is what makes "ship a hosted deployment" a matter of writing
// a sibling entry point (`mainCloud.ts` with a Postgres bundle) rather than forking the server. The
// boundary test enforces exactly that: `@cascade/storage-sqlite` may be imported here and nowhere else.
//
// Wiring, in order:
//   1. open the embedded DB (created + migrated in-process on first launch)
//   2. hand the server a per-session tracer that writes spans into it
//   3. hand the server a dispose() so shutdown flushes the buffer instead of dropping it

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSqliteTracer, createTelemetryStorage } from '@cascade/storage-sqlite'
import { start } from './wsServer.js'

/** Where app state lives. On the desktop this becomes Electron's `app.getPath('userData')`, passed in by
 *  the shell; standalone we mirror the convention so `npm run dev` and the packaged app share one DB. */
const APP_DATA = process.env.CASCADE_APP_DATA || join(homedir(), '.cascade')
const DB_FILE = process.env.CASCADE_DB || join(APP_DATA, 'cascade.db')

const storage = createTelemetryStorage({ file: DB_FILE })

await start({
  // One tracer per SESSION, not per turn: it holds that session's open spans, and it mints a fresh trace
  // on every submit (see sqliteTracer) so the Observatory lists turns, not sessions.
  sessionTracerFor: ({ projectId, kind, model }) => createSqliteTracer(storage.traces, { projectId, model, rootName: `agent (${kind})` }),
  traces: storage.traces, // the READ side — what the Observatory queries
  dispose: () => storage.dispose(),
})
