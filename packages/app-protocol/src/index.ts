// @cascade/app-protocol — the app/builder WIRE protocol (the wrapper layer).
//
// @cascade/core's protocol describes ONE agent session (ActivityEvent / InboundMessage). But a
// prompt-to-app builder also has concepts that span MANY sessions and the app surface itself —
// projects, and later live preview, terminal, versions, file browsing. Those are NOT one session's
// activity, so they must NOT live in core. They live here, in the wrapper layer, and the server + web
// frontends speak them ALONGSIDE core's session protocol.
//
// Rule (see PLAN): managing/composing sessions or an app/UI surface ⇒ a BuilderEvent/BuilderCommand here,
// never a core ActivityEvent. This package depends on NOTHING (not even core): the union
// `ActivityEvent ∪ BuilderEvent` is formed at the frontends/server, keeping the layers decoupled.

/** A project = a workspace dir + its own long-lived CascadeSession, owned by the server's ProjectManager.
 *  This is the public, host-path-free view (the `dir` never crosses the wire). */
export type ProjectInfo = { id: string; name: string; createdAt: string }

/** ADR-081 §4: where a project's commands execute. 'wsl' (ADR-070 step 5, Windows): the cascade-sandbox
 *  WSL2 VM — Docker-grade isolation with no Docker install. */
export type RuntimeMode = 'host' | 'docker' | 'wsl'

/** What the UI needs to render the runtime setting HONESTLY — which is more than the chosen value.
 *
 *  `mode` is what is actually running; `requested` is what the user asked for. They differ when Docker was
 *  selected but is not answering, and the app fell back rather than refusing to start. Showing only the
 *  setting in that case would tell the user they have isolation when they do not. */
export interface RuntimeInfo {
  mode: RuntimeMode
  requested: RuntimeMode
  dockerAvailable: boolean
  /** CASCADE_SANDBOX=off pins host mode; the UI disables the control rather than letting it lie. */
  forcedHost?: boolean
  /** ADR-070 step 7: the WSL runtime is offerable (Windows + wsl.exe present + a registered distro or a
   *  bundled rootfs). The UI shows the WSL option only when true. */
  wslAvailable?: boolean
  /** ADR-070 step 7: host mode is NOT necessarily unprotected — on a machine with a local backend
   *  (Windows write-fence, macOS Seatbelt, Linux bwrap) the agent's commands are still confined. Present
   *  only when host mode actually confines; the UI states the honest degree ('full' vs 'partial') instead
   *  of a blanket "no isolation". Absent ⇒ host mode is genuinely unconfined on this machine. */
  hostConfinement?: { backend: string; enforcement: 'full' | 'partial' }
}

/** A project scaffold the agent can start from (Phase 15). */
export type TemplateInfo = { id: string; name: string; description: string }

/** A node in the project's file tree (M4). `path` is RELATIVE to the project root — host paths never cross
 *  the wire. Dirs carry `children`; files don't. */
export type FileNode = { name: string; path: string; type: 'file' | 'dir'; children?: FileNode[] }

/** A build/type-check problem (M5.3). `file` is RELATIVE to the project root. */
export type Problem = { file: string; line: number; col: number; message: string }

/** A git checkpoint of the project (M6). `id` is the commit hash. */
export type Version = { id: string; summary: string; createdAt: string }

/** One chat (conversation) in a project (M11). Stored server-side; the client only sees this metadata. */
export type ChatMeta = { id: string; title: string; createdAt: string; updatedAt: string }

/** A flattened transcript row sent when switching to a saved chat (M11) — the server derives these from the
 *  chat's core messages so the protocol stays decoupled from core's Message shape. LEGACY fallback: chats
 *  recorded before the replay log existed render from these reduced rows. */
export type ChatHistoryItem = { role: 'user' | 'assistant' | 'tool'; text: string; name?: string }

/** One replayable transcript entry: the user's submit text, or a relayed session event exactly as it was
 *  streamed live. The client re-dispatches `event` through the SAME reducer that rendered the live session,
 *  so a reloaded chat renders identically to how it was built — by construction, not by reconstruction.
 *  `event` is opaque here (an ActivityEvent) to keep the protocol decoupled from core's event shape. */
export type ChatReplayEntry = { user: string } | { event: unknown }

/** Builder → client. App/workspace-level events, distinct from a session's ActivityEvents.
 *  Future variants (added in their phases) — keep the discriminated union open:
 *    | { type: 'preview';  projectId: string; url: string; status: 'installing' | 'running' | 'error' }
 *    | { type: 'terminal'; projectId: string; data: string }
 *    | { type: 'versions'; projectId: string; versions: { id: string; summary: string; createdAt: string }[] }
 *    | { type: 'files';    projectId: string; tree: ... }
 */
/** ADR-067: the OFFICIAL ceilings that bound a model's config sliders (from the server's model-spec table:
 *  max context window / output tokens / temperature, and whether the model exposes top_k at all). */
export interface ModelLimits {
	contextMax: number
	outputMax: number
	tempMax: number
	topK: boolean
}

/** ADR-067: a curated model plus its editable per-model params (context window, output cap, sampling).
 *  Shared by the `enabledModels` event and the `setModelParams` command. */
export interface EnabledModelInfo {
  provider: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
  presencePenalty?: number
  /** TASK-thinking-control: reasoning-effort knob ('off'|'low'|'medium'|'high'). Omit ⇒ model default. */
  thinking?: 'off' | 'low' | 'medium' | 'high'
  /** ADR-076: custom OpenAI-compatible endpoint (e.g. a rented vLLM/SGLang box). The CLEAN URL — safe to show. */
  baseUrl?: string
  /** ADR-076: whether an API key is stored server-side for this endpoint. The key VALUE is never sent to the client. */
  hasKey?: boolean
  /** ADR-077: wire protocol for a custom endpoint — 'ollama' uses the native /api/chat (reports prefill/decode
   *  timings); omitted ⇒ the OpenAI-compatible /v1 path. */
  api?: 'openai' | 'ollama'
}

/** ADR-071: one configured connector (MCP server) + its live status, as shown in the Connectors UI. `url` is
 *  the CLEAN endpoint (the key is stored separately, never in the url) so it can be shown for EDITING; the
 *  key itself is server-side only — the client sees `hasKey` (a boolean), never the value. `command` appears
 *  only for a local stdio server (extension / opted-in box); the web UI never adds those. */
export interface McpServerInfo {
  name: string
  url?: string // HTTP connector — the endpoint, no secret; editable
  hasKey?: boolean // an API key IS set (value never sent)
  apiKeyIn?: string // how the key is applied ('query:<param>' | 'header:<name>' | 'bearer') — lets the editor label the field
  command?: string // stdio (local-only), shown read-only if present
  disabled?: boolean
  status?: 'connecting' | 'ready' | 'failed' | 'disabled'
  toolCount?: number
  error?: string
}

/** ADR-081: one trace's headline row for the Observatory list. A TRACE is one TURN (the tracer mints a
 *  fresh id per submit), so this row answers "what happened when I hit send". `projectId` is the project
 *  ID — the host dir never crosses the wire, so spans are stamped with the id at write time. */
export interface TraceSummaryInfo {
  traceId: string
  name: string
  /** What was asked. Every root is called "agent (builder)" — the prompt is what tells turns apart. */
  prompt?: string
  /** Epoch ms. The client formats; the server does not guess a timezone. */
  startedAt: number
  /** Absent while the turn is still running — see `running`. */
  durationMs?: number
  spanCount: number
  status?: 'ok' | 'error'
  /** At least one span is still open. Separate from `status`: a turn can be in flight AND already carry a
   *  failed tool call, and collapsing the two hides one or the other. */
  running?: boolean
  projectId?: string
  model?: string
  /** The conversation this turn came from — lets the Observatory open a trace back in its chat. */
  chatId?: string
}

/** ADR-081: one span. Flat (parent by id) rather than nested — the client builds the tree, so a span with a
 *  missing parent can still be shown instead of vanishing with its subtree. `attributes` carries the
 *  observables diagnosis actually uses: tokens, prefill/decode ms, context window, tool input/output. */
export interface SpanInfo {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN'. Open on purpose — a new tracer kind must not break the client. */
  kind: string
  startedAt: number
  endedAt?: number
  status?: 'ok' | 'error'
  attributes?: Record<string, unknown>
}

/** ADR-081: one CONVERSATION, many turns. A trace is one turn (Phoenix, LangSmith and Langfuse all model
 *  it that way), so an app build produces dozens of traces and a flat list buries what you were doing.
 *  Every one of those tools answers this with a grouping layer keyed on a session id; this is ours.
 *  `firstPrompt`/`lastOutput` are the columns they converge on — they identify a conversation far better
 *  than an id does. */
export interface SessionInfo {
  chatId: string
  projectId?: string
  firstPrompt?: string
  lastOutput?: string
  turnCount: number
  startedAt: number
  endedAt: number
  errorTurns: number
  outputTokens: number
  models: string[]
  running?: boolean
}

export type BuilderEvent =
  | { type: 'serverInfo'; sandbox: boolean; model: string; provider?: string; providers?: { id: string; configured: boolean }[]; runtime?: RuntimeInfo; keyStorage?: 'encrypted' | 'unavailable' | 'session' } // greeting: runtime, active provider/model, and the provider menu (ADR-067)
  | { type: 'mcpServers'; servers: McpServerInfo[] } // ADR-071: configured MCP servers + live connection status (the MCP panel)
  | { type: 'models'; provider: string; models: string[]; reachable?: boolean } // reachable=false ⇒ nothing listening — the UI shows a launch command, not an empty catalog // ADR-067: models a provider offers (for the picker)
  | { type: 'modelInfo'; provider: string; model: string; capabilities: string[]; contextWindow?: number; limits?: ModelLimits } // ADR-067: one model's capabilities + context + slider limits (manager)
  | { type: 'enabledModels'; models: EnabledModelInfo[] } // ADR-067: the CURATED models shown in the picker (with per-model params)
  | { type: 'turnActivity'; projectId?: string; chatId?: string; phase: 'running' | 'awaiting' | null } // ADR-068: the single active turn — drives the sidebar dot + composer lock + re-attach on return
  | { type: 'projects'; projects: ProjectInfo[]; activeId?: string } // project sidebar snapshot
  | { type: 'projectCreated'; project: ProjectInfo } // a project was just created (so the Home flow can open it)
  | { type: 'templates'; templates: TemplateInfo[] } // available scaffolds for the create flow (Phase 15)
  | { type: 'files'; tree: FileNode[] } // the active project's file tree (M4)
  | { type: 'fileContent'; path: string; content: string; truncated?: boolean } // a single file's content (M4)
  | { type: 'fileEdited'; path: string; ok: boolean } // result of a visual edit; ok:false ⇒ not inline-editable, fall back to AI (M9)
  | { type: 'fileOpError'; action: string; message: string } // a file-tree op failed (e.g. name exists) — surfaced as a toast (M9)
  | { type: 'fileDiff'; path: string; original: string; modified: string } // a file's diff vs last commit (M2; Monaco DiffEditor)
  | { type: 'preview'; status: 'installing' | 'starting' | 'running' | 'error' | 'stopped'; url?: string; error?: string } // live preview (M3); `error` explains a failure (e.g. dev-server port drift)
  | { type: 'log'; line: string } // a dev-server stdout/stderr line for the Console pane (M5)
  | { type: 'problems'; problems: Problem[]; checking?: boolean } // type-check results for the Problems panel (M5.3)
  | { type: 'versions'; versions: Version[] } // checkpoint history for the Versions panel (M6)
  | { type: 'chats'; chats: ChatMeta[]; activeId: string } // the active project's chat list (M11)
  | { type: 'chatHistory'; items: ChatHistoryItem[]; events?: ChatReplayEntry[] } // the switched-to chat's transcript; `events` = high-fidelity replay log (items = legacy fallback)
  | { type: 'allChats'; groups: { project: ProjectInfo; chats: ChatMeta[] }[] } // every project's chats, for the Chats page
  | { type: 'terminalData'; id: string; data: string } // a chunk of a terminal session's PTY output (M7)
  | { type: 'terminalExit'; id: string } // a terminal session's shell ended (M7)
  // ADR-081: the Observatory's trace list. `append` ⇒ a pagination page, not a fresh result set — the
  // client concatenates instead of replacing, so "load more" doesn't fight the poll.
  | { type: 'traces'; traces: TraceSummaryInfo[]; append?: boolean; models?: string[] }
  | { type: 'traceSpans'; traceId: string; spans: SpanInfo[] } // ADR-081: one trace's spans (the waterfall)
  | { type: 'spanResults'; spans: SpanInfo[] } // ADR-081: cross-trace span search hits
  | { type: 'spanDetail'; span: SpanInfo } // ADR-081: one span with its payloads intact
  | { type: 'sessions'; sessions: SessionInfo[] } // ADR-081: turns grouped into conversations

/** Client → builder. App/workspace-level commands, distinct from a session's InboundMessages.
 *  Future variants (added in their phases): preview start/stop/refresh, terminal input/resize,
 *  version restore/checkout, file read/write, etc. */
export type BuilderCommand =
  | { type: 'project'; action: 'list' | 'create' | 'open' | 'delete'; name?: string; id?: string; templateId?: string }
  | { type: 'setModel'; provider: string; model: string; baseUrl?: string } // ADR-067: switch provider/model at runtime (no restart)
  | { type: 'listModels'; provider: string; baseUrl?: string } // ADR-067: ask for a provider's model list (→ `models`)
  | { type: 'modelInfo'; provider: string; model: string; baseUrl?: string } // ADR-067: ask for one model's capabilities+context (→ `modelInfo`)
  | { type: 'setApiKey'; provider: string; key: string } // ADR-067: set a provider's API key for the running server (→ fresh serverInfo)
  | { type: 'setRuntimeMode'; mode: RuntimeMode } // ADR-081 §4: switch where the agent's commands run (→ fresh serverInfo)
  | { type: 'addModel'; provider: string; model: string; contextWindow?: number; baseUrl?: string; apiKey?: string; api?: 'openai' | 'ollama' } // ADR-067/076/077: add a model; baseUrl+apiKey+api configure a custom endpoint (key stored server-side, never echoed; api picks the wire protocol)
  | { type: 'removeModel'; provider: string; model: string } // ADR-067: remove a model from the curated list
  | { type: 'setModelContext'; provider: string; model: string; contextWindow?: number } // ADR-067: set a model's context-window override
  | { type: 'setModelParams'; provider: string; model: string; params: Omit<EnabledModelInfo, 'provider' | 'model'> } // ADR-067: merge editable per-model params (context/output/sampling)
  | { type: 'listMcpServers' } // ADR-071: request the configured connectors (→ mcpServers)
  // ADR-071: add OR EDIT an HTTP connector. `url` is the clean endpoint. `apiKey` semantics: OMITTED ⇒ keep
  // the existing key (edit the host without re-entering the key); '' ⇒ clear it; a string ⇒ set/replace it.
  // `apiKeyIn` says how to apply it. The key lives server-side and is never echoed back.
  | { type: 'addMcpServer'; name: string; url: string; apiKey?: string; apiKeyIn?: string; headers?: Record<string, string> }
  | { type: 'removeMcpServer'; name: string } // ADR-071: delete a connector
  | { type: 'toggleMcpServer'; name: string; disabled: boolean } // ADR-071: enable/disable without deleting
  | { type: 'files'; action: 'list' } // request the active project's file tree (M4)
  | { type: 'file'; action: 'read' | 'diff'; path: string } // read a file (M4) or get its diff vs last commit (M2)
  | { type: 'file'; action: 'write'; path: string; content: string } // overwrite a file (M9 visual editing / Code-pane save)
  | { type: 'file'; action: 'editText'; path: string; line: number; col: number; text: string } // replace a JSX element's text (M9)
  | { type: 'file'; action: 'setClass'; path: string; line: number; col: number; className: string } // set a JSX element's className (M9 toolbar)
  | { type: 'file'; action: 'create' | 'mkdir' | 'delete'; path: string } // file-tree ops: new file / new folder / delete (M9)
  | { type: 'file'; action: 'rename'; path: string; to: string } // rename/move a file or folder (M9)
  | { type: 'preview'; action: 'start' | 'stop' } // start/stop the active project's live preview (M3)
  | { type: 'check' } // run a type-check; results come back as a `problems` event (M5.3)
  | { type: 'versions'; action: 'list' } // request the checkpoint history (M6)
  | { type: 'version'; action: 'restore'; id: string } // restore the project to a checkpoint (M6)
  | { type: 'terminal'; action: 'start' | 'stop'; id: string; cols?: number; rows?: number } // open/close a session (M7)
  | { type: 'terminalInput'; id: string; data: string } // keystrokes → a session's PTY (M7)
  | { type: 'terminalResize'; id: string; cols: number; rows: number } // a session's xterm resized (M7)
  | { type: 'chat'; action: 'list' | 'new' | 'switch' | 'delete' | 'rename'; id?: string; title?: string } // multi-chat (M11)
  | { type: 'chats'; action: 'listAll' } // request every project's chat list (the Chats page)
  // ADR-081: the Observatory. `projectId` omitted ⇒ every project's traces (the page is global, like Chats).
  // `before` is the pagination cursor: the oldest startedAt already held. With it the reply is a PAGE
  // (append), without it a fresh result set.
  | { type: 'traces'; action: 'list'; projectId?: string; model?: string; status?: 'ok' | 'error'; q?: string; chatId?: string; limit?: number; before?: number; beforeId?: string }
  | { type: 'sessions'; action: 'list'; projectId?: string; limit?: number } // ADR-081: the grouped view
  | { type: 'trace'; action: 'spans'; traceId: string } // one trace's spans (→ traceSpans), payloads trimmed
  // ADR-081: ONE span, untrimmed. Prompts are stored whole now, so the tree fetch cannot carry them —
  // it polls every 3s and would ship megabytes per tick. The detail pane asks for what it is showing.
  | { type: 'span'; action: 'detail'; spanId: string }
  // Spans across ALL traces — "every failed Bash", "every turn that mentions RecipeGrid". The question a
  // per-trace viewer structurally cannot answer.
  | { type: 'spans'; action: 'search'; projectId?: string; kind?: string; status?: 'ok' | 'error'; q?: string; limit?: number }
