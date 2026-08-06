// @cascade/storage — the storage PORTS (ADR-081).
//
// Cascade ships as a native desktop binary now and as a hosted web app later. Rather than fork the
// server for each, every piece of durable STATE moves behind an interface here, and the deployment
// supplies the adapter: SQLite + local fs on the desktop, Postgres + object storage in the cloud.
//
// The rule that makes this real: `packages/server` must not import `node:fs`, a database driver, or
// `electron`. It receives stores by constructor injection — the same discipline that already governs
// `mcpConnect`, `sandboxFor` and `Tracer`. The test of the abstraction is that writing the Postgres
// adapter requires ZERO changes to the server.
//
// What is deliberately NOT here: the project's own source files. Those stay real files in every
// deployment (git checkpoints, user edits, `npm install` all need a filesystem) and are already behind
// core's `Sandbox` port — desktop adds `HostSandbox` beside `DockerSandbox`, the cloud swaps in a
// remote container. One port, three backends, no new abstraction needed.

// ── Chats ────────────────────────────────────────────────────────────────────────────────────────────
/** One conversation's metadata. `projectId` scopes it; the cloud adapter adds a user column. */
export interface ChatRecord {
  id: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
}

/** One replayable transcript entry: the user's submit text, or a relayed session event exactly as it
 *  streamed. `event` stays opaque (an ActivityEvent) so this package depends on nothing. */
export type ReplayEntry = { user: string } | { event: unknown }

export interface ChatStore {
  list(projectId: string): Promise<ChatRecord[]>
  /** Every project's chats in one query — the Chats page. Directory scanning made this O(projects). */
  listAll(): Promise<ChatRecord[]>
  get(chatId: string): Promise<ChatRecord | undefined>
  create(chat: Omit<ChatRecord, 'createdAt' | 'updatedAt'>): Promise<ChatRecord>
  rename(chatId: string, title: string): Promise<void>
  delete(chatId: string): Promise<void>
  /** Append ONE entry. Fire-and-forget at the call site: adapters buffer and flush in a transaction
   *  (ADR-081 §3 — the cost is the commit, not the insert), so this must never be awaited in the loop. */
  append(chatId: string, entry: ReplayEntry): void
  /** The full replay log, in order — the client re-dispatches these through the live reducer. */
  replay(chatId: string): Promise<ReplayEntry[]>
  /** Flush any buffered appends. Call before shutdown; adapters with no buffer no-op. */
  flush(): Promise<void>
}

// ── Config (models, connectors) ──────────────────────────────────────────────────────────────────────
/** A curated model plus its per-model overrides. Mirrors the shape the model manager already edits. */
export interface ModelRecord {
  provider: string
  model: string
  baseUrl?: string
  contextWindow?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
}

/** An MCP connector. The key is stored SEPARATELY from the endpoint so either can be edited alone,
 *  and it is never returned to a client — adapters expose `hasKey` upward, not the value. */
export interface ConnectorRecord {
  name: string
  url?: string
  apiKey?: string
  apiKeyIn?: string
  headers?: Record<string, string>
  command?: string
  disabled?: boolean
}

export interface ConfigStore {
  models(): Promise<ModelRecord[]>
  upsertModel(model: ModelRecord): Promise<void>
  removeModel(provider: string, model: string): Promise<void>
  activeModel(): Promise<{ provider: string; model: string; baseUrl?: string } | undefined>
  setActiveModel(m: { provider: string; model: string; baseUrl?: string }): Promise<void>
  connectors(): Promise<ConnectorRecord[]>
  /** Merge semantics the editor depends on: `apiKey` UNDEFINED keeps the stored key (so the host can
   *  change without re-entering it), '' clears it, a string replaces it. */
  upsertConnector(c: ConnectorRecord): Promise<void>
  removeConnector(name: string): Promise<void>
  /** Free-form app settings (runtimeMode, telemetry consent, theme…). */
  setting<T = unknown>(key: string): Promise<T | undefined>
  setSetting(key: string, value: unknown): Promise<void>
}

// ── Traces ───────────────────────────────────────────────────────────────────────────────────────────
/** One span, flattened. Deliberately close to OTel so the OTLP exporter and this store can be fanned
 *  out to together, and so a hosted adapter can forward to a real backend unchanged. */
export interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: string
  startedAt: number
  endedAt?: number
  status?: 'ok' | 'error'
  /** projectId/chatId/model — what the Observatory filters and groups by. */
  attributes?: Record<string, unknown>
}

/** A trace's headline row for the list view (derived from its root span). */
export interface TraceSummary {
  traceId: string
  name: string
  startedAt: number
  /** Only meaningful once the trace is finished — a running trace has no total yet (see `running`). */
  durationMs?: number
  spanCount: number
  status?: 'ok' | 'error'
  /** At least one span has not closed. Kept SEPARATE from `status` because a turn can be both in flight
   *  and already carrying a failed tool call, and a list that collapses the two either hides live turns or
   *  hides their errors. Without this a running build is indistinguishable from a finished one. */
  running?: boolean
  projectId?: string
  model?: string
}

export interface TraceStore {
  /** Buffered by the adapter — see ChatStore.append. The agent loop never awaits telemetry. */
  record(span: SpanRecord): void
  listTraces(opts?: { projectId?: string; limit?: number; before?: number }): Promise<TraceSummary[]>
  spans(traceId: string): Promise<SpanRecord[]>
  /** Retention: a desktop install must not grow without bound. */
  prune(olderThanMs: number): Promise<number>
  flush(): Promise<void>
}

// ── Blobs (screenshots, uploads) ─────────────────────────────────────────────────────────────────────
/** Binary attachments. Local fs on the desktop, S3/R2 in the cloud — hence a port rather than a path. */
export interface BlobStore {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array | undefined>
  delete(key: string): Promise<void>
  /** A URL the UI can render. Desktop returns a file:// or served path; cloud returns a signed URL. */
  url(key: string): Promise<string | undefined>
}

// ── The bundle the server receives ───────────────────────────────────────────────────────────────────
/** Everything durable, injected as one object. A deployment builds this; the server never constructs it. */
export interface Storage {
  chats: ChatStore
  config: ConfigStore
  traces: TraceStore
  blobs: BlobStore
  /** Release adapter resources (close the DB, flush buffers). Called on shutdown. */
  dispose(): Promise<void>
}
