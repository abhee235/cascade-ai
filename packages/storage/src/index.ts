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
  /** One project's chats, newest first. A PURE read — it never creates or deletes. "Open the last chat, or
   *  make one" is UI policy and lives in the server; a store that invents rows on read cannot be reasoned
   *  about (and made `list` unusable for the read-only Chats page, which is why `peek` had to exist). */
  list(projectId: string): Promise<ChatRecord[]>
  /** Every project's chats in one query — the Chats page. Directory scanning made this O(projects). */
  listAll(): Promise<ChatRecord[]>
  get(chatId: string): Promise<ChatRecord | undefined>
  create(chat: Omit<ChatRecord, 'createdAt' | 'updatedAt'>): Promise<ChatRecord>
  rename(chatId: string, title: string): Promise<void>
  delete(chatId: string): Promise<void>
  /**
   * Drop abandoned empty chats — still titled "New chat", no history, no replay log. `keepId` is spared:
   * the ACTIVE chat is legitimately empty while someone is composing in it.
   *
   * Emptiness must consider the REPLAY LOG, not just messages. A chat whose turn is still running has
   * events but no saved history and no title yet (history is written when the turn ends), so a
   * messages-only test classifies a live build as abandoned and deletes it. Measured: opening a project
   * mid-build pruned the running chat and orphaned its 499-event log.
   *
   * Returns the ids it removed, so a caller can tell whether the active chat list actually changed.
   */
  prune(projectId: string, keepId?: string): Promise<string[]>
  /** The agent's conversation for this chat. `unknown[]` deliberately: the shape belongs to core's Message
   *  type and this package depends on NOTHING — the server casts on the way out. */
  messages(chatId: string): Promise<unknown[]>
  /** Replace the conversation, bump `updatedAt`, and — if the chat is still untitled — derive its title from
   *  `firstUserText`. One call rather than a save plus a touch, because two writes can disagree and a chat
   *  that saved its history but lost its title reads as a bug. */
  saveMessages(chatId: string, messages: unknown[], firstUserText?: string): Promise<void>
  /** Append ONE entry. Fire-and-forget at the call site: adapters buffer and flush in a transaction
   *  (ADR-081 §3 — the cost is the commit, not the insert), so this must never be awaited in the loop. */
  append(chatId: string, entry: ReplayEntry): void
  /** The chat's replay log, oldest first — the client re-dispatches these through the live reducer. Adapters
   *  return the most recent `limit` entries: a marathon chat replays its tail, not an unbounded log. */
  replay(chatId: string, limit?: number): Promise<ReplayEntry[]>
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
  /** ADR-076: the key for a custom endpoint. Stored server-side and NEVER returned to a client — the
   *  registry exposes `hasKey` upward instead. It lives on the record because the endpoint is useless
   *  without it, and splitting them would mean two writes that can disagree. */
  apiKey?: string
  /** ADR-077: wire protocol for a custom endpoint — 'ollama' uses the native /api/chat. */
  api?: 'openai' | 'ollama'
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
  /** What was ASKED — the root span's input. Every root is called "agent (builder)", so a list of turns
   *  is unreadable without this: the prompt is what distinguishes one from the next. */
  prompt?: string
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
  /** The conversation this turn came from, so a trace can be opened back in its chat. */
  chatId?: string
}

/** What the trace list can be narrowed by. `before` is the pagination cursor (a startedAt): pass the
 *  oldest row you already hold to fetch the next page. */
export interface TraceQuery {
  projectId?: string
  model?: string
  /** 'error' is the one that matters — "show me the turns that went wrong" is the first question asked. */
  status?: 'ok' | 'error'
  /** Free text over the trace name and the user's prompt (the root span's input). */
  q?: string
  /** Narrow to one conversation — how the Sessions view drills into its turns. */
  chatId?: string
  limit?: number
  /** Keyset cursor: the startedAt of the oldest row already held. */
  before?: number
  /** Tie-breaker for `before`. Turns can share a millisecond (fast successive submits, a backfill replay
   *  of recorded timestamps), and a plain `started_at < cursor` silently DROPS every row that ties with
   *  the boundary. Measured: 150 traces paged out as 136. Pass the oldest row's traceId with `before`. */
  beforeId?: string
}

/**
 * One CONVERSATION's headline row — many turns, grouped.
 *
 * A trace is one turn (Phoenix, LangSmith and Langfuse all model it this way), so building an app
 * produces dozens of traces and a flat list buries the thing you were actually doing. Every one of those
 * tools answers this with a grouping layer keyed on a session id; this is ours. `firstPrompt` and
 * `lastOutput` are the columns they converge on, because "what did I ask for, and where did it end up"
 * identifies a conversation far better than an id does.
 */
export interface SessionSummary {
  chatId: string
  projectId?: string
  /** What opened the conversation — the title, in practice. */
  firstPrompt?: string
  /** Where it ended up, from the most recent model response. */
  lastOutput?: string
  turnCount: number
  startedAt: number
  endedAt: number
  /** Turns that contain at least one failed span. */
  errorTurns: number
  /** Completion tokens across the session — the local-model stand-in for cost. */
  outputTokens: number
  /** Distinct models used. A mid-session model switch is a fact worth seeing at this level. */
  models: string[]
  /** Any span still open ⇒ this conversation has a turn in flight. */
  running?: boolean
}

/** A cross-trace span query. This is the difference between a trace VIEWER and something that answers
 *  questions: "every failed Bash", "every turn where compaction fired", "every call that mentions
 *  RecipeGrid" — none of which can be asked one trace at a time. */
export interface SpanQuery {
  projectId?: string
  /** 'LLM' | 'TOOL' | 'CHAIN' | 'AGENT'. */
  kind?: string
  status?: 'ok' | 'error'
  /** Free text over the span name and its input/output attributes. */
  q?: string
  limit?: number
}

export interface TraceStore {
  /** Buffered by the adapter — see ChatStore.append. The agent loop never awaits telemetry. */
  record(span: SpanRecord): void
  listTraces(opts?: TraceQuery): Promise<TraceSummary[]>
  /** Turns grouped into conversations, newest first. The Observatory's default view. */
  listSessions(opts?: { projectId?: string; limit?: number }): Promise<SessionSummary[]>
  spans(traceId: string): Promise<SpanRecord[]>
  /** ONE span, with its payloads intact. The tree fetch trims them for transport (a prompt is now stored
   *  whole and a waterfall does not need it); this is how the detail pane gets the real thing. */
  span(spanId: string): Promise<SpanRecord | undefined>
  /** Spans across ALL traces, newest first. See SpanQuery for why this exists. */
  searchSpans(opts?: SpanQuery): Promise<SpanRecord[]>
  /** The distinct models seen, newest-used first — so a model filter offers real choices, not a free-text box. */
  models(): Promise<string[]>
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
