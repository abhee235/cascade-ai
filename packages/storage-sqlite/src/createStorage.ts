// createStorage.ts — the composition root for the desktop adapter (ADR-081 §6).
//
// The ENTRY POINT builds this and injects it; `packages/server` never constructs it and never learns
// which backend it got. That is the whole point of the boundary test: swapping in a Postgres bundle
// later must not touch the server.
//
// Scope note, deliberately honest: `traces`, `config` and `chats` are implemented; `blobs` is not. Rather
// than stub the missing one with a throwing placeholder — which would let a caller wire it and fail at
// RUNTIME — this exposes a bundle whose type says exactly what exists, widening to the full `Storage` as
// BlobStore lands. A type error at the wiring site beats a crash in front of a user.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatStore, ConfigStore, TraceStore } from '@cascade/storage'
import { openDb, type Db } from './db.js'
import { createTraceStore } from './traceStore.js'
import { createConfigStore } from './configStore.js'
import { createChatStore } from './chatStore.js'

export interface TelemetryStorage {
  traces: TraceStore
  config: ConfigStore
  chats: ChatStore
  /** Escape hatch for migrations/inspection while the bundle is still partial. */
  db: Db
  /** Flush buffers and close. Call on app shutdown — buffered spans are lost otherwise. */
  dispose(): Promise<void>
}

export interface CreateStorageOptions {
  /** Absolute path to the DB file, e.g. <userData>/cascade.db. Parent dirs are created. */
  file: string
  /** Drop spans older than this on open. Default 14 days — a desktop install runs for months and
   *  nobody prunes manually. Pass 0 to disable. */
  retentionMs?: number
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

export function createTelemetryStorage(opts: CreateStorageOptions): TelemetryStorage {
  mkdirSync(dirname(opts.file), { recursive: true }) // first launch has no app-data dir yet
  const db = openDb(opts.file)
  const traces = createTraceStore(db)
  const config = createConfigStore(db)
  const chats = createChatStore(db)

  // Prune at OPEN, not on a timer: a desktop app is closed more often than it is left running, and a
  // background interval would keep waking the process for work that only matters across sessions.
  const retention = opts.retentionMs ?? DEFAULT_RETENTION_MS
  if (retention > 0) void traces.prune(retention)

  return {
    traces,
    config,
    chats,
    db,
    async dispose() {
      // BOTH buffers, before the handle closes: spans and replay events are in memory until this runs, and
      // a lost replay log is a transcript that reloads blank.
      await traces.flush()
      await chats.flush()
      db.close()
    },
  }
}
