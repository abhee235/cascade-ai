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
import { createSpanTracer } from '@cascade/core'
import { createTelemetryStorage, importLegacyConfig } from '@cascade/storage-sqlite'
import { PROJECTS_ROOT, start } from './wsServer.js'

/** Where app state lives. On the desktop this becomes Electron's `app.getPath('userData')`, passed in by
 *  the shell; standalone we mirror the convention so `npm run dev` and the packaged app share one DB. */
const APP_DATA = process.env.CASCADE_APP_DATA || join(homedir(), '.cascade')
const DB_FILE = process.env.CASCADE_DB || join(APP_DATA, 'cascade.db')

const storage = createTelemetryStorage({ file: DB_FILE })

// ADR-081 §2: an existing install's models/connectors live in JSON under the projects root. Import them
// ONCE so upgrading does not look like losing your configuration. No-op on a fresh install, and a no-op
// on every launch after the first — the legacy files are left in place either way.
const moved = await importLegacyConfig(storage.config, join(PROJECTS_ROOT, '.cascade'))
if (moved.models || moved.connectors || moved.active) {
  console.log(`Imported existing config into ${DB_FILE}: ${moved.models} model(s), ${moved.connectors} connector(s)${moved.active ? ', active model' : ''}.`)
}

await start({
  // The desktop's telemetry sink: core's ONE event→span fold, writing straight into the store. There is
  // no SQLite-specific tracer any more — `traces.record` is the whole sink, which is what stops this path
  // and the OTLP one from drifting (ADR-081 amendment).
  //
  // One instance per SESSION, not per turn: it holds that session's open spans, and mints a fresh trace
  // on every submit so the Observatory lists turns, not sessions.
  sessionTracerFor: ({ projectId, kind, model }) => createSpanTracer((span) => storage.traces.record(span), { projectId, model, rootName: `agent (${kind})` }),
  traces: storage.traces, // the READ side — what the Observatory queries
  config: storage.config, // models, connectors, settings — the registries read through this now
  dispose: () => storage.dispose(),
})
