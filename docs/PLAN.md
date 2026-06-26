# Cascade — Build a Coding Agent as a VS Code Extension (Learning Curriculum)

## Context

You want to deeply understand how a coding agent's algorithm works by **building one from scratch**,
slowly, phase by phase, as a VS Code extension named **Cascade**. The backend model is **Ollama**
(local).

This is a tutorial, not a fork. We do **not** copy anyone's source. Each phase teaches one concept,
explains where it sits in the agent's architecture, and has you implement a clean version yourself.

**The agent engine is headless and frontend-agnostic.** The VS Code extension is just the *first*
frontend. A standalone **web app / chat in the browser** will drive the **same** core algorithm by
connecting to a Cascade server over WebSocket. So from Phase 0 the code is a **monorepo**: a pure
`@cascade/core` engine (no VS Code, no DOM) + thin frontends (extension, web) + a server that hosts the
core for remote clients. This is the usual split between an agent's core and its frontends (terminal
UI, web server, remote-session bridge). — **ADR-018**.

**Cascade keeps the parts of a mature coding agent worth admiring** — the agentic loop, persistent
memory, context handling, and error recovery — and **deliberately diverges** where you have a better
preference:

- **Streamed output + activity view (IDE-assistant style).** Stream prose AND thinking
  token-by-token to the UI (as `ActivityEvent` deltas), emit a final `message` the UI commits, and also
  show coarse `status` / (Phase 4+) tool-step activity for *actions*. — **ADR-013**. (This is the
  common approach to streaming; an earlier draft wrongly said "no prose streaming" and was corrected.)
- **MCP: background discovery + lazy retry.** Connect enabled servers in the **background** at startup
  (discovery requires a connection — you can't advertise a tool without `tools/list`), advertise once ready;
  retry a **failed** server lazily on next use — never block startup. — **ADR-014**.

A **canonical mapping table** (concept ↔ Cascade module) is maintained so we never drift off the
target architecture, and every concept has one obvious home under a descriptive name.

**Deliverables:**
1. A new sibling **monorepo** `cascade/` added to the workspace (multi-root),
   with packages: `core` (headless engine), `extension` (VS Code frontend), `server` (hosts core over
   WebSocket), `web` (browser chat frontend).
2. `docs/` in Cascade: ADRs (`docs/adr/`), the phased guide (`docs/guide/`), and an architecture
   overview with the concept↔module mapping.
3. Runnable code at the end of every phase (each phase = a usable, git-tagged checkpoint).
4. Two test-case queries + a self-check at the end of each phase.

---

## Naming Convention & Canonical Mapping (the "don't drift" table)

Cascade uses **descriptive, standard names**. This table is the single source of truth that anchors
each concept to its Cascade module. Keep it open while building.

| Purpose | Cascade module → function |
|---------|---------------------------|-----------------------|
| Host entry / activation | `src/extension.ts` → `activate()` | [src/main.tsx](src/main.tsx) |
| Webview provider | `src/CascadeViewProvider.ts` → `resolveWebviewView()` |
| **Agentic loop** | `agent/agentLoop.ts` → `runAgentLoop()` |
| Message model | `agent/conversation.ts` (types) | [src/types/message.ts](src/types/message.ts) |
| System prompt | `agent/systemPrompt.ts` → `buildSystemPrompt()` |
| Model provider (abstraction) | `llm/provider.ts` `ModelProvider` + `llm/factory.ts` `createProvider()` (ADR-020) |
| Provider impl / format bridge | `llm/providers/openaiCompat.ts` (`complete()`; Phase 2 adds `stream()`) |
| Tool contract | `tools/Tool.ts` → `Tool` |
| Tool registry | `tools/toolRegistry.ts` → `buildRegistry()` / `findTool()` |
| Execute one tool | `tools/runTool.ts` → `executeTool()` |
| Concurrency scheduling | `tools/scheduler.ts` → `scheduleTools()` |
| Permissions | `permissions/gate.ts` → `checkPermission()` |
| Observability | `observability/tracer.ts` → `JsonlTracer` |
| Bash (stream + abort) | `tools/builtins/Bash.ts` → `BashTool` | BashTool |
| **Memory** | `memory/memoryStore.ts` → `loadMemory()` / `updateMemory()` |
| MCP (bg discovery + retry) | `mcp/mcpHub.ts` → `McpHub.start()` (background) / `retryFailed()`; `mcp/sdkConnect.ts` |
| Tool registry (dynamic) | `tools/toolRegistry.ts` → `createRegistry()` / `ToolRegistry` |
| Compaction | `context/compactor.ts` → `compactIfNeeded()` |
| **Error recovery** | `llm/resilience.ts` → `withRecovery()` |
| Subagent tool | `tools/builtins/Subagent.ts` |
| **Core engine / session** | `core/session.ts` → `createSession()` / `CascadeSession` |
| **Wire protocol** | `core/protocol.ts` → `ActivityEvent` |
| **Server (remote host)** | `server/wsServer.ts` |
| **Transport (WS)** | `web/wsClient.ts` | [src/cli/transports/](src/cli/transports/) |
| Extension frontend | `extension/CascadeViewProvider.ts` |
| Web frontend | `web/App.tsx` | [src/server/web/](src/server/web/) |

### Deliberate design choices
| Topic | Common approach | Cascade | ADR |
|-------|-------------|---------|-----|
| Output display | Streams prose token-by-token live | **Same — streams prose + thinking live**, plus a status/tool-step activity view (IDE-assistant style). Not a divergence. | ADR-013 |
| MCP connect timing | Connects servers at startup (can block) | **Background** discovery at startup + lazy retry on failure (non-blocking) | ADR-014 |
| Naming | Terse internal names | Descriptive standard (`runAgentLoop`, `executeTool`, …) | — |

---

## Target Architecture (monorepo: one engine, many frontends)

```
cascade/  (npm/pnpm workspaces)
│
├─ packages/core/        @cascade/core — THE ALGORITHM (headless; no vscode, no DOM)
│   └─ src/
│       ├─ session.ts          CascadeSession: submit()→AsyncIterable<ActivityEvent>
│       ├─ agent/
│       │   ├─ agentLoop.ts     runAgentLoop()                  (cf. query.ts queryLoop :241)
│       │   ├─ conversation.ts  internal message model          (cf. types/message.ts)
│       │   └─ systemPrompt.ts  buildSystemPrompt()             (cf. context.ts)
│       ├─ llm/
│       │   ├─ modelClient.ts   streamCompletion() + bridge
│       │   └─ resilience.ts    withRecovery()
│       ├─ tools/
│       │   ├─ Tool.ts          contract                        (cf. Tool.ts :362)
│       │   ├─ toolRegistry.ts  buildRegistry()/findTool()      (cf. tools.ts)
│       │   ├─ runTool.ts       executeTool()                  
│       │   ├─ scheduler.ts     scheduleTools()                
│       │   └─ builtins/        Read, Glob, Grep, Bash, Edit, Write, Subagent
│       ├─ permissions/gate.ts  checkPermission()
│       ├─ memory/memoryStore.ts loadMemory()/updateMemory()
│       ├─ mcp/mcpHub.ts        connectMcpServerOnFirstUse()
│       ├─ context/compactor.ts compactIfNeeded()
│       └─ protocol.ts          ActivityEvent + Inbound types (the WIRE protocol)
│
├─ packages/extension/   VS Code frontend — embeds @cascade/core IN-PROCESS            ← Ink CLI frontend
│   ├─ src/{extension.ts, CascadeViewProvider.ts}   drives a CascadeSession directly
│   └─ ui/{Transcript.tsx, ActivityView.tsx}        React webview
│
├─ packages/server/      @cascade/server — hosts @cascade/core, exposes WebSocket
│   └─ src/wsServer.ts    one CascadeSession per connection; streams ActivityEvents
│
├─ packages/web/         standalone browser chat — connects to server
│   └─ src/{App.tsx, Transcript.tsx, ActivityView.tsx, wsClient.ts}
│
├─ packages/shared-ui/   (optional) React components reused by extension webview + web
└─ docs/{adr,guide}/
```

**Two ways a frontend drives the core (ADR-018):** the **extension** consumes a `CascadeSession`
**in-process** (just calls `core.createSession()`); the **web app** consumes the *same* session **over a
transport** — the `server` runs the core and relays the **identical `ActivityEvent` protocol** over
WebSocket. Because the engine only ever emits serializable `ActivityEvent`s and accepts serializable
inbound messages, the in-process and remote paths are interchangeable.

**ADR-003 (kept):** Cascade uses a **content-block internal message model** (text / thinking / tool_use /
tool_result blocks) translated to/from OpenAI **only** inside `llm/modelClient.ts`. Everything above the
client — in *any* frontend — sees that one provider-neutral shape.

---

## Tech Stack

- **Language:** TypeScript (strict). **Extension:** VS Code API; `contributes.views` sidebar.
- **UI:** React in a `WebviewView`; host↔webview via `postMessage`. Bundled with esbuild.
- **LLM:** Ollama OpenAI-compat `http://127.0.0.1:11434/v1/chat/completions` (stream + tools).
- **Schemas:** Zod → JSON Schema (cf. `src/utils/zodToJsonSchema.ts`).
- **MCP:** `@modelcontextprotocol/sdk` (stdio first), connected lazily.
- **Model:** a tool-capable Ollama model (e.g. `qwen2.5-coder` / `qwen36-agentic`).

## Prerequisites & Setup (do once, before Phase 0)
- [ ] **Node** ≥ 18, **VS Code**.
- [ ] **Ollama** running: `ollama serve` (`127.0.0.1:11434`).
- [ ] Tool-capable model pulled: `ollama pull qwen2.5-coder` (or reuse `qwen36-agentic`).
- [ ] Verify: `curl http://127.0.0.1:11434/v1/models`.
- [ ] **Run the extension:** open `cascade/` → **F5** → Extension Development Host; Cascade sidebar lives there.
- [ ] **Windows gotcha:** use `127.0.0.1`, not `localhost` (IPv6 `::1` won't reach Ollama).

## Checkpoint discipline (git)
- Cascade is its own git repo. **One commit per phase**, tagged `phase-0`…`phase-13`.
- Commit only once both test queries pass and the self-check is answerable.

---

## Core Internal Types (the spine — grows across phases)

```ts
// agent/conversation.ts — internal message model (content blocks)  [Phase 3]
type ContentBlock =
  | { type: 'text';        text: string }
  | { type: 'thinking';    thinking: string }
  | { type: 'tool_use';    id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; isError?: boolean }
type Message =
  | { role: 'user';      content: string | ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] }

// llm/modelClient.ts — internal stream events (consumed to drive ACTIVITY, not prose)  [Phase 2/4]
type StreamEvent =
  | { type: 'text_delta';     text: string }       // buffered; NOT painted live (ADR-013)
  | { type: 'thinking_delta'; thinking: string }   // surfaced as "Thinking…" activity, not prose
  | { type: 'tool_use_start'; index: number; id: string; name: string }
  | { type: 'tool_use_delta'; index: number; partialJson: string }  // accumulate; parse at stop
  | { type: 'block_stop';     index: number }
  | { type: 'done';           stopReason: 'end_turn' | 'tool_use' | 'max_tokens'; usage?: Usage }

// core/session.ts — the frontend-agnostic entry point (ADR-018)  [Phase 0 stub → grows]
interface CascadeSession {
  submit(userText: string): AsyncIterable<ActivityEvent>   // drive one turn-set; yields activity
  respondPermission(id: string, decision: 'allow' | 'allow-always' | 'deny'): void
  abort(): void
}
function createSession(opts: { cwd: string; model: string; baseUrl: string }): CascadeSession
// Frontends consume this: extension in-process; web app via server relaying the same events over WS.

// core/protocol.ts — ActivityEvent IS the wire protocol (serializable; same in-process & over WS)  [Phase 2/8/12]
type ActivityEvent =
  | { type: 'status';     text: string }                       // "Thinking…", "Generating…"
  | { type: 'toolStart';  id: string; name: string; summary: string }   // "Reading package.json"
  | { type: 'toolProgress'; id: string; chunk: string }        // e.g. bash stdout (may stream)
  | { type: 'toolResult'; id: string; ok: boolean; preview: string }
  | { type: 'permission'; id: string; tool: string; detail: string }    // blocks on user
  | { type: 'message';    message: Message }                   // FINAL answer, rendered whole
  | { type: 'turnDone';   steps: number }

// tools/Tool.ts — contract (P4 core, +flags P6, +permissions P7, +progress P8, +mcp P9)
interface Tool<I = unknown, O = unknown> {
  name: string
  description: string
  inputSchema: ZodType<I>
  activitySummary(input: I): string                 // "Reading package.json" — for the activity view
  call(input: I, ctx: ToolContext, onProgress?: (p: ToolProgress) => void): Promise<ToolResult<O>>
  isReadOnly?(input: I): boolean                     // Phase 6
  isConcurrencySafe?(input: I): boolean              // Phase 6
  checkPermissions?(input: I, ctx: ToolContext): Promise<'allow' | 'ask' | 'deny'>  // Phase 7
  isMcp?: boolean                                    // Phase 9
}
type ToolResult<O> = { data: O; toAPIContent(): string; isError?: boolean }
type ToolContext = { cwd: string; abortSignal: AbortSignal /* +memory, +permissions later */ }
```

---

## Code Skeletons (the shape of each key file)

```ts
// src/extension.ts  [Phase 0]
export function activate(ctx: vscode.ExtensionContext) {
  const provider = new CascadeViewProvider(ctx)
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('cascade.view', provider))
}

// src/CascadeViewProvider.ts  [Phase 0 → grows every phase]
class CascadeViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true }
    view.webview.html = renderHtml(view.webview)
    view.webview.onDidReceiveMessage(msg => this.onSubmit(msg, view.webview))
  }
  // onSubmit: drive runAgentLoop(); forward ActivityEvents to the webview (NOT raw text deltas)
}

// llm/modelClient.ts  [P1 call, P2 stream, P3 translate, P4 tools]
async function* streamCompletion(
  messages: Message[], tools: Tool[], signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const body = { model, messages: toProviderMessages(messages), tools: toProviderTools(tools), stream: true }
  const res = await fetch(`${baseUrl}/v1/chat/completions`, { method:'POST', body: JSON.stringify(body), signal })
  // fromProviderStream(res): buffer NDJSON lines → map content→text_delta, reasoning→thinking_delta,
  //   tool_calls→tool_use_start/tool_use_delta, finish_reason→done
}
function toProviderMessages(messages: Message[]): OpenAIMessage[] { /* tool_use→tool_calls, tool_result→role:'tool' */ }

// agent/agentLoop.ts  [Phase 4 → the heart; extended P6/P7/P8/P10/P11]
async function* runAgentLoop(state: LoopState): AsyncGenerator<ActivityEvent> {
  while (true) {
    const assistant: ContentBlock[] = []
    yield { type:'status', text:'Thinking…' }
    for await (const ev of withRecovery(() => streamCompletion(state.messages, state.tools, state.signal))) {
      accumulateInto(assistant, ev)                 // build blocks; DO NOT emit text to UI here
      if (ev.type === 'tool_use_start') yield { type:'status', text:'Planning tools…' }
    }
    state.messages.push({ role:'assistant', content: assistant })
    const toolUses = assistant.filter(b => b.type === 'tool_use')
    if (toolUses.length === 0) {                    // ← TERMINAL: render the whole answer now
      yield { type:'message', message: { role:'assistant', content: assistant } }
      return
    }
    const results = yield* scheduleTools(toolUses, state)   // P6; emits toolStart/Progress/Result
    state.messages.push({ role:'user', content: results })
    if (++state.turn > state.maxTurns) return       // P11 guard
  }
}

// tools/runTool.ts  [Phase 5]
async function executeTool(block: ToolUseBlock, state: LoopState): Promise<ContentBlock> {
  const tool = findTool(state.tools, block.name)
  if (!tool) return errorResult(block.id, 'No such tool')
  const parsed = tool.inputSchema.safeParse(block.input)
  if (!parsed.success) return errorResult(block.id, format(parsed.error))   // feed error back → self-correct
  if (await checkPermission(tool, parsed.data, state) === 'deny') return errorResult(block.id, 'Denied')
  const result = await tool.call(parsed.data, state.ctx, onProgress)
  return { type:'tool_result', tool_use_id: block.id, content: result.toAPIContent(), isError: result.isError }
}

// tools/scheduler.ts  [Phase 6]
async function* scheduleTools(blocks: ToolUseBlock[], state: LoopState): AsyncGenerator<ActivityEvent, ContentBlock[]> {
  // partition consecutive isConcurrencySafe blocks → Promise.all; others serial.
  // emit toolStart/toolProgress/toolResult ActivityEvents; return tool_result[] in request order.
}
```

---

## ADR Index
Each ADR is a short file in `cascade/docs/adr/`: Context → Decision → Consequences → Prior art.

| ADR | Title | Phase |
|-----|-------|-------|
| ADR-001 | TypeScript VS Code extension + React webview | 0 |
| ADR-002 | Ollama via OpenAI-compat `/v1/chat/completions` | 1 |
| ADR-003 | Content-block internal message model; translate at LLM boundary | 2–3 |
| ADR-004 | Streaming as a typed internal event generator | 2 |
| ADR-005 | Agentic loop = async generator that recurses on tool_use | 4 |
| ADR-006 | Tool contract: name + Zod schema + `call()` + flags | 4 |
| ADR-007 | Execution pipeline: lookup → validate → permit → call → result | 5 |
| ADR-008 | Concurrency: read-only parallel, writes serial | 6 |
| ADR-009 | Permission model: allow/ask/deny + modes + rules | 7 |
| ADR-010 | Webview↔host **ActivityEvent** protocol | 8 |
| ADR-011 | MCP integration; `mcp__server__tool` namespacing | 9 |
| ADR-012 | Context compaction (layered, ratio-sized; + coupled curation) | 11 |
| **ADR-013** | **Streamed output (prose+thinking live) + activity view** | 2 (used through 8) |
| **ADR-014** | **MCP init: background discovery + lazy retry (divergence)** | 9 |
| ADR-015 | Memory: tiered, self-curating subsystem (core+archival+proactive) | 10 |
| ADR-016 | Error recovery & resilience (retry/backoff/fallback/abort/overflow) | 12 |
| ADR-017 | Subagents (nested loop with own context) | 12 |
| **ADR-018** | **Frontend-agnostic core + transport boundary (in-process & WebSocket)** | 0 (realized in 13) |
| **ADR-019** | **Web app (browser chat) over the Cascade server** | 13 |
| ADR-021 | Tool-calling strategies: native / structured-output / prompt-based ReAct | 14 |
| ADR-023 | Observability: forensic JSONL tracer | 7.5 (inserted) |

> **Phase renumber (memory earned its own phase):** 10 = Memory subsystem · 11 = Compaction (+ coupled
> curation) · 12 = Resilience & Subagents · 13 = Server + Web · 14 = Tool-calling strategies.

---

## Deep-dive: The Agentic Loop + Streaming Tool-Call Accumulation (the trickiest part)

### The loop in one breath
> Call the model with the full history. Consume its streamed reply. **If** the reply contains any
> `tool_use` blocks, run those tools, append their `tool_result`s, and **call the model again**.
> Repeat until a reply has **no** `tool_use` blocks — that's the terminal answer (rendered whole).

In Cascade this is `runAgentLoop`; the line that *is* the agent is the recurse back into the model
call.

### Why streaming tool calls are subtle
The model streams a tool call as **fragments of a JSON string**. Across deltas you get:
```
tool_calls[0] = { index:0, id:'call_1', function:{ name:'Read' } }
tool_calls[0] = { index:0, function:{ arguments:'{"file' } }
tool_calls[0] = { index:0, function:{ arguments:'_path":"REA' } }
tool_calls[0] = { index:0, function:{ arguments:'DME.md"}' } }
finish_reason = 'tool_calls'
```
Accumulate `arguments` **by index** into a buffer; `JSON.parse` **once** at the end. Cascade:
`tool_use_start` → N× `tool_use_delta` (append) → `block_stop` (parse + finalize).

### Sequence (one turn that uses a tool — Cascade activity-first rendering)
```
UI submit "what's in README?"
  host → runAgentLoop()
    status: "Thinking…"                            (activity, NOT prose)
    streamCompletion():
      text_delta "I'll read it"   → buffered (not shown)
      tool_use_start idx0 Read
      tool_use_delta idx0 '{"file_path":"README.md"}'   → accumulate
      block_stop idx0             → parse {file_path:'README.md'}
      done stopReason=tool_use
    assistant has tool_use → NOT terminal
    scheduleTools([Read]):
      toolStart  "Reading README.md"               (activity chip)
      executeTool: lookup→validate→permit(read=allow)→call
      toolResult ok "·· 120 lines"                 (result card)
    append assistant + tool_result; turn++
    streamCompletion()  (2nd round-trip; model now sees the file)
      text_delta "The README describes…" → buffered
      done stopReason=end_turn
    assistant has 0 tool_use → TERMINAL
    message: <whole assistant answer rendered at once>
    turnDone steps=1
```

### Edge cases (handled across phases)
- **Parallel calls:** interleaved `index`es → keep `Map<index,buffer>`; run read-only ones together (P6).
- **Malformed tool JSON:** parse fails → return an *error* tool_result so the model self-corrects (P5).
- **Abort mid-stream/tool:** one `AbortController` cancels fetch + in-flight tools (P8/P11).
- **Runaway loop:** cap with `maxTurns` (P11).
- **Result ordering:** map each tool_result to its `tool_use_id` regardless of finish order (P6).

---

## The Curriculum (14 checkpoints, Phase 0–13)

> Phases 1–11 build `@cascade/core` (the algorithm) driven by the `extension` frontend. Phase 12 proves
> the core is frontend-agnostic by adding the `server` + `web` (browser chat) frontend on the same engine.

> Every phase: **Goal → 🎯 Learning objective → The idea → Build checklist → ⚠️ Pitfalls
> → ADR(s) → 2 test queries → ✅ Self-check.** Each ends with runnable, git-tagged code.

### Phase 0 — Monorepo scaffold & "hello webview"
**Goal:** A workspaces monorepo with an empty `@cascade/core` and a VS Code `extension` that opens a
Cascade sidebar (React chat box) and echoes through a **`CascadeSession` stub from core**. No model yet.
**🎯 You'll understand:** the host/webview split AND the core/frontend split — why the algorithm lives in a
headless package the extension merely *drives*, so a web app can later drive the same package.
**The idea:** Establish the seams first: `core` exposes `createSession()` (stub that echoes); `extension`
consumes it in-process and renders via webview `postMessage`. Everything rides on these seams.

```
cascade/
├─ package.json                 (workspaces: packages/*)
├─ packages/
│   ├─ core/      package.json · tsconfig · src/session.ts (createSession stub) · src/protocol.ts
│   └─ extension/ package.json (contributes.views) · esbuild.mjs · .vscode/launch.json
│                 src/{extension.ts, CascadeViewProvider.ts} · ui/{index.html, main.tsx, Transcript.tsx}
└─ docs/{adr,guide}/
```
**Build checklist:**
- [ ] Root workspaces `package.json`; `packages/core` + `packages/extension`.
- [ ] `core/session.ts`: `createSession()` returning a stub `CascadeSession` whose `submit()` echoes an `ActivityEvent` `message`.
- [ ] `core/protocol.ts`: `ActivityEvent` + inbound types.
- [ ] `extension`: `activate()` registers `CascadeViewProvider`; provider imports `@cascade/core`, drives a session.
- [ ] React shell: transcript + input + send; `postMessage` round-trip.
- [ ] Add `cascade/` as a 2nd workspace root.
- [ ] `docs/adr/ADR-001-stack.md`, `docs/adr/ADR-018-core-frontend-split.md`.
**⚠️ Pitfalls:** putting any `vscode`/DOM import in `core` (keep it headless); missing `enableScripts`; CSP without a nonce; losing state on webview reload (the core/host owns state).
**Test queries:** 1) "hello" → core echoes it as a `message` ActivityEvent → bubble appears. 2) reload window → sidebar reopens, interactive.
**✅ Self-check:** *What must NEVER be imported inside `@cascade/core`, and why does that enable the web app later?*

---

### Phase 1 — One-shot Ollama call (no streaming, no tools)
**Goal:** Send text to Ollama, render the full reply.
**🎯 You'll understand:** the model is just an HTTP endpoint; "AI" is one POST with a messages array.
**The idea:** `POST /v1/chat/completions` `{model,messages}`; reply in `choices[0].message.content`.

**Build checklist:**
- [ ] `llm/modelClient.ts`: `{stream:false}` call → text.
- [ ] Map `{role,content}` → OpenAI messages.
- [ ] Host calls on submit; posts reply.
- [ ] Settings `cascade.model`, `cascade.baseUrl`.
- [ ] `docs/adr/ADR-002-ollama.md`.
**⚠️ Pitfalls:** `localhost` vs `127.0.0.1`; missing `Content-Type`; swallowing HTTP errors.
**Test queries:** 1) "2+2, number only" → `4`. 2) "haiku about TypeScript" → 3 lines.
**✅ Self-check:** *Minimum request fields, and where is the reply text?*

---

### Phase 2 — Internal token stream + activity-first UI (no prose streaming)
**Goal:** Consume Ollama's token stream **internally**; show a live "what it's doing" status; render the
finished answer **once** at the end. **This is where Cascade diverges from the usual terminal-agent UX
(ADR-013).**
**🎯 You'll understand:** the async-generator producer/consumer pattern (the agent's backbone) AND the
deliberate product decision to decouple *internal streaming* from *display* — IDE-assistant style.
**The idea:** `stream:true` yields NDJSON deltas → typed `StreamEvent`s. We **accumulate** text instead of
painting it; the webview shows `status`/activity while generating, then one `message` event renders the
complete answer. Thinking shows as a "Thinking…" status, never as streamed prose.
*Divergence:* a terminal agent typically forwards text deltas to its TUI; Cascade does not.
**Build checklist:**
- [ ] `modelClient.ts`: `fromProviderStream()` buffers lines, yields `StreamEvent`s.
- [ ] Define `StreamEvent` + `ActivityEvent` unions.
- [ ] Host consumes stream, emits `status`/`message` ActivityEvents (no `text_delta` to UI).
- [ ] Webview `ActivityView`: status chip while working; `Transcript` renders the final message whole.
- [ ] Thinking → collapsible summary after completion.
- [ ] `docs/adr/ADR-004-streaming.md`, `docs/adr/ADR-013-activity-ui.md`.
**⚠️ Pitfalls:** JSON object split across chunks (buffer remainder); `[DONE]` sentinel; accidentally
forwarding prose deltas (defeats the divergence).
**Test queries:** 1) "explain closures in 1 paragraph" → "Thinking…/Generating…" shows, then the whole
paragraph appears at once (not token-by-token). 2) reasoning prompt → "Thinking…" status, then answer +
expandable thinking summary.
**✅ Self-check:** *We still stream from Ollama internally — why, if we don't show prose live?*

---

### Phase 3 — Conversation state, message model & system prompt
**Goal:** Multi-turn memory (in-session), content-block message model, real system prompt.
**🎯 You'll understand:** why an agent keeps an internal model distinct from the wire format, and how a system
prompt grounds the agent (identity + cwd/OS/date).
**The idea:** Model is stateless — resend full history each turn; store it as content blocks; translate to
OpenAI only in the client.

**Build checklist:**
- [ ] `agent/conversation.ts` types.
- [ ] `toProviderMessages()` translator (isolated).
- [ ] Host persists history; sends full history.
- [ ] `agent/systemPrompt.ts` (identity + env).
- [ ] "New chat" clears history.
- [ ] Finish `docs/adr/ADR-003-message-model.md`.
**⚠️ Pitfalls:** webview owning history (dies on reload); system prompt not sent first.
**Test queries:** 1) "My name is Abhi." → "What's my name?" → "Abhi". 2) "What directory are you in?" → workspace cwd.
**✅ Self-check:** *Where does state live, and why not the webview?*

---

### Phase 4 — First tool & the agentic loop (ReAct) — **the heart**
**Goal:** One read-only tool (`Read`) + the loop that detects `tool_use`, runs it, feeds results back, re-calls until no tool_use.
**🎯 You'll understand:** "agentic" = a `while` loop around a stateless model. You implement the exact recurse that *is* the agent.
**The idea:** Read the Deep-dive above, then build `runAgentLoop`. Send tool schemas; accumulate streamed
tool-call JSON by index; on `done`, run tools if present, append results, loop; else render the answer.

**Build checklist:**
- [ ] `tools/Tool.ts` (name, description, inputSchema, activitySummary, call).
- [ ] `tools/builtins/Read.ts`.
- [ ] Send tool schemas; accumulate `tool_calls` by index, parse at stop.
- [ ] `agent/agentLoop.ts` `runAgentLoop()` (skeleton).
- [ ] Activity: `toolStart` "Reading X" + `toolResult` card.
- [ ] `docs/adr/ADR-005-agentic-loop.md`, `ADR-006-tool-contract.md`.
**⚠️ Pitfalls:** parsing tool JSON per-delta; infinite loop from mis-fed results; missing stable tool ids.
**Test queries:** 1) "Read package.json, tell me the project name" → Read runs, answer from contents.
2) "What scripts are defined?" → model→tool→model round-trip.
**✅ Self-check:** *Exact condition that ends the loop, and what restarts it?*

---

### Phase 5 — Tool execution pipeline (validation, results, errors)
**Goal:** Real pipeline: lookup, Zod validation, structured result, graceful errors. Add `Glob`, `Grep`.
**🎯 You'll understand:** the defensive gap between "model asked" and "tool ran", and why feeding
validation errors *back* makes the agent self-correcting (part of the error-recovery you admire).
**The idea:** Never trust model output. lookup → `safeParse` → on failure return error result → call.

**Build checklist:**
- [ ] `tools/toolRegistry.ts` `buildRegistry()`/`findTool()`.
- [ ] `tools/runTool.ts` `executeTool()`; error→tool_result.
- [ ] `Glob.ts`, `Grep.ts`.
- [ ] Standard `ToolResult` + tool_result wrapper.
- [ ] Unknown-tool / tool-threw paths.
- [ ] `docs/adr/ADR-007-execution-pipeline.md`.
**⚠️ Pitfalls:** throwing on bad input (return error instead); unwrapped exceptions; oversized results.
**Test queries:** 1) "Find all .ts under src" → Glob → count. 2) "Search 'activate'" → Grep; then a bad input → validation error feeds back → retry.
**✅ Self-check:** *Why return validation errors to the model rather than throwing?*

---

### Phase 6 — Multiple tools & concurrency
**Goal:** Several tool calls per turn; read-only parallel, writes serial. Add `Write`, `Edit`.
**🎯 You'll understand:** the concurrency rule is a *correctness* decision (reads safe, writes race), not just speed.
**The idea:** Tag tools `isReadOnly`/`isConcurrencySafe`; group safe → `Promise.all`; others serial; preserve order.

**Build checklist:**
- [ ] Add flags to contract; set per builtin.
- [ ] `tools/scheduler.ts` `scheduleTools()`.
- [ ] `Write.ts`, `Edit.ts`.
- [ ] Preserve result ordering.
- [ ] `docs/adr/ADR-008-concurrency.md`.
**⚠️ Pitfalls:** parallel writes (corruption); shuffled result order; treating `cd`/redirect as read-only.
**Test queries:** 1) "Read package.json and tsconfig.json and compare" → two parallel Reads. 2) "Create notes.txt 'hello' then read it" → Write then Read, correct order.
**✅ Self-check:** *Why are two parallel writes unsafe but two reads fine?*

---

### Phase 7 — Permissions
**Goal:** allow/ask/deny before a tool runs; webview approval card; modes + rules.
**🎯 You'll understand:** how an agent stays safe with a not-fully-trusted model — the gate between intent and effect.
**The idea:** `checkPermission` per tool; read auto-allow, writes/Bash ask; "ask" blocks the loop on a card; modes/rules shortcut.

**Build checklist:**
- [ ] `permissions/gate.ts` `checkPermission()`.
- [ ] Read auto-allow; Write/Edit/Bash → ask.
- [ ] Webview permission card (Allow once/always/Deny) that blocks until answered.
- [ ] Modes `default|acceptEdits|plan|bypass`.
- [ ] Persisted allow/deny rules.
- [ ] `docs/adr/ADR-009-permissions.md`.
**⚠️ Pitfalls:** loop not awaiting the answer; `plan` leaking a write; over-broad rules.
**Test queries:** 1) "Delete notes.txt" → card; Deny → model adapts. 2) `acceptEdits` + "comment README" → no prompt; `plan` → blocked.
**✅ Self-check:** *Which step holds the permission check, and what blocks the loop on "ask"?*

---

### Phase 8 — Tool activity timeline + live progress (polish the activity-first UI)
**Goal:** Start safe tools the moment their call closes; stream tool *progress* (Bash stdout) into its card;
finalize the `ActivityEvent` protocol. Add `Bash`. (Still no prose streaming — ADR-013 holds.)
**🎯 You'll understand:** the latency win — dispatch safe tools at `block_stop`, not at `done` — and a clean
activity protocol that shows "what it's doing" without painting prose.
**The idea:** As a concurrency-safe tool's block closes, dispatch it; stream its `toolProgress`; one
`AbortController` stops stream + tools.

**Build checklist:**
- [ ] `tools/builtins/Bash.ts`: spawn shell, stream stdout/stderr via `onProgress`.
- [ ] Dispatch safe tools at `block_stop`.
- [ ] `ADR-010` `ActivityEvent` protocol (status/toolStart/toolProgress/toolResult/permission/message/turnDone).
- [ ] Webview: live tool cards, spinners, collapse/expand, Stop.
- [ ] `AbortController` wired to Stop.
- [ ] `docs/adr/ADR-010-activity-protocol.md`.
**⚠️ Pitfalls:** starting a *write* tool early (only safe ones); zombie shells on abort; progress racing the result.
**Test queries:** 1) "Run `npm ls --depth=0`" → stdout streams into the card; Stop cancels. 2) "Read all config files then run `node -v`" → parallel reads during streaming, bash after, ordered.
**✅ Self-check:** *Which tools may start before the message finishes, and why not all?*

---

### Phase 9 — MCP (background discovery + lazy retry)
**Goal:** Register MCP servers from config, connect them **in the background at startup** to discover/advertise
their tools, and **retry a failed server lazily** on next use; merge as `mcp__<server>__<tool>`.
**🎯 You'll understand:** MCP = a protocol for discovering/calling external tools, normalized into the same
`Tool` contract — and *why discovery requires a connection* (so pure-lazy can't advertise tools), hence
**background** discovery (non-blocking) + lazy retry. — ADR-014.
**The idea:** On startup, kick off connecting each enabled server in the background → `initialize` +
`tools/list` → wrap each returned tool as a `Tool` (its JSON Schema is the inputSchema) → advertise once
`ready`. A server that errors is marked `failed` and reconnected on the next turn / next attempted use. The
registry becomes dynamic: builtins **+** ready MCP tools.
*Divergence:* the common approach connects at startup (can block); Cascade connects in the
**background** + retries lazily.
**Build checklist:**
- [ ] `@modelcontextprotocol/sdk`; `mcp/mcpHub.ts` (per-server state: registered→connecting→ready/failed).
- [ ] Read `cascade.mcpServers`; **background** connect each enabled server (non-blocking startup).
- [ ] On connect: `initialize` + `tools/list`; wrap each as a `Tool` (`mcp__server__tool`, server JSON Schema).
- [ ] Route calls via `client.callTool()`; cache the connection; **retry** a `failed` server on next use.
- [ ] Merge into a **dynamic** registry (sort + dedupe, builtins win); surface connection status.
- [ ] `docs/adr/ADR-011-mcp.md`, `ADR-014-mcp-init.md`.
**⚠️ Pitfalls:** BLOCKING startup on a slow/hung server (must be background); advertising a tool before its
server is `ready`; name collisions; huge descriptions; leaked subprocess on dispose.
**Test queries:** 1) Configure a filesystem server → after startup its `mcp__filesystem__*` tools appear
(connected in the background) and "list this folder via MCP" runs. 2) Point a server at a bad command → it
shows `failed`, the rest keep working, and it reconnects when next used.
**✅ Self-check:** *Why can't we advertise an MCP tool without connecting first, and how does "background
discovery + lazy retry" differ from both pure-lazy and a blocking startup connect?*

---

### Phase 10 — Context: compaction & persistent memory
**Goal:** Keep long conversations within the window (compaction) and add **persistent memory** the agent reads each session and can update via a tool.
**🎯 You'll understand:** two of the most valuable agent features — finite-context handling and durable memory —
and how they combine so the agent "remembers" across sessions without unbounded history.
**The idea:** Estimate tokens; over threshold, summarize older messages into a compact boundary and
continue. Add `memory/memoryStore.ts`: a project memory file injected into the system prompt; a `Memory`
tool (or auto-update) lets the agent persist durable facts.

**Build checklist:**
- [ ] `context/compactor.ts` `compactIfNeeded()` (summarize-old-into-boundary).
- [ ] `memory/memoryStore.ts` `loadMemory()`/`updateMemory()`; inject memory into `buildSystemPrompt()`.
- [ ] `tools/builtins/Memory.ts` (or auto-capture) to persist facts.
- [ ] UI: "context compacted" marker; memory indicator.
- [ ] `docs/adr/ADR-012-compaction.md`, `ADR-015-memory.md`.
**⚠️ Pitfalls:** compaction dropping needed facts (summarize, don't truncate blindly); memory growing unbounded; memory not actually injected.
**Test queries:** 1) Long back-and-forth until compaction triggers → conversation keeps working, earlier facts survive. 2) "Remember that I prefer tabs." → new chat → "What's my indent preference?" → "tabs" (from persisted memory).
**✅ Self-check:** *When compaction runs, what's preserved vs replaced — and how does memory survive a new session?*

---

### Phase 11 — Resilience & Subagents (capstone)
**Goal:** Harden the loop with **error recovery** (retry/backoff, fallback, abort, overflow→compact) and add a **Subagent** tool that runs a nested loop with its own context.
**🎯 You'll understand:** the error recovery that makes an agent dependable, plus delegation — a tool that is itself an agent — exercising the whole stack.
**The idea:** Wrap the model call in `withRecovery()`: retry transient failures with backoff, fall back on
overload, recover from context overflow by compacting then retrying, and honor abort. Add
`tools/builtins/Subagent.ts` that calls `runAgentLoop` with a sub-prompt + tool subset, returning a summary.

**Build checklist:**
- [ ] `llm/resilience.ts` `withRecovery()`: retry+backoff, fallback model, abort, overflow→`compactIfNeeded`→retry.
- [ ] `maxTurns` guard with a clear end reason.
- [ ] `tools/builtins/Subagent.ts`: nested `runAgentLoop` (own context + tool subset) → summary result; depth cap.
- [ ] UI: recovery notices; nested-agent activity (indented timeline).
- [ ] `docs/adr/ADR-016-resilience.md`, `ADR-017-subagents.md`.
- [ ] Final `docs/architecture.md`: full concept↔module mapping.
**⚠️ Pitfalls:** infinite retry (cap attempts); recursive subagents with no depth cap; miscounting turns vs calls; swallowing a real error as "retryable".
**Test queries:** 1) Point at a wrong/stopped Ollama port mid-session (or force a transient 500) → `withRecovery` retries/falls back and surfaces a clear notice instead of crashing. 2) "Use a subagent to research how the tool registry works, then summarize" → Subagent spawns a nested loop, runs its own Read/Grep, returns a summary into the parent transcript.
**✅ Self-check:** *Which failures are retryable vs fatal, and how does a subagent's context differ from the parent's?*

---

### Phase 12 — Cascade Server + Web App (browser chat) — proves the core is frontend-agnostic
**Goal:** Stand up `@cascade/server` that hosts `@cascade/core` and relays the **same `ActivityEvent`
protocol** over WebSocket, then build `@cascade/web` — a standalone browser chat — that
drives the identical engine. No core logic is rewritten; only a transport is added.
**🎯 You'll understand:** the payoff of the Phase-0 core/frontend split — one engine, many frontends —
and how one agent can be served to a terminal, a web client, and remote sessions.
**The idea:** The web app can't import `core` in-process (it's a browser), so `server` runs the core and
forwards events: browser `submit` → WS → `server` calls `session.submit()` → streams `ActivityEvent`s back
over WS → web renders the *same* activity timeline + final message. Permission prompts and abort travel the
same socket. The extension keeps using the core in-process — both frontends share the engine and protocol.

**Build checklist:**
- [ ] `packages/server/src/wsServer.ts`: on each WS connection, `createSession()`; map inbound `{submit|permission|abort}` → session calls; stream `ActivityEvent`s out as JSON.
- [ ] Session lifecycle: one session per connection; clean up on disconnect/abort.
- [ ] `packages/web`: React chat app reusing `Transcript`/`ActivityView` (via `shared-ui` or copied); `wsClient.ts` connects, sends inbound, renders `ActivityEvent`s.
- [ ] Chat-app UX: conversation list, streaming activity timeline, final-answer rendering, permission cards, Stop.
- [ ] Confirm the **extension still works unchanged** (in-process) — same protocol both ways.
- [ ] `docs/adr/ADR-019-web-app.md`; finalize `docs/architecture.md` (one engine, three frontends).
**⚠️ Pitfalls:** leaking core internals over the wire (only `ActivityEvent`s cross); no auth/origin check on the WS (lock to localhost for the tutorial); backpressure on fast tool output; serializing non-JSON (e.g. functions) into events.
**Test queries (run in the browser web app, against the server):**
1. "Read package.json and summarize it" → the web chat shows the same activity timeline (Reading… ✓) and renders the final answer whole — identical behavior to the extension, different frontend.
2. "Run `node -v` then delete temp.txt" → Bash progress streams over WS; the permission card for delete appears in the browser and Deny propagates back through the socket to the core.
**✅ Self-check:** *What is the only kind of data that crosses the WebSocket, and why does that make the extension and web app interchangeable?*

---

### Phase 13 — Tool-calling strategies for any model (structured-output + prompt-based ReAct) — capstone extension
**Goal:** make Cascade work with models that **lack native tool calling**, by adding two more provider
strategies behind the same interface. The whole point: prove the architecture — only the **provider**
changes; `runAgentLoop`, the tools, and the UI are untouched.
**🎯 You'll understand:** the tool-calling capability spectrum, and that the fallback is quarantined in the
provider because the loop only ever consumes `tool_use` `StreamEvent`s (ADR-020 + the StreamEvent boundary).
**The idea (3 tiers):** native `tool_calls` (Phase 4) → **structured output** (force JSON via
`response_format`/grammar; prompt for `{"tool","input"}`; parse) → **prompt-based ReAct** (describe tools
in the system prompt; scrape a `<tool_call>{…}</tool_call>` marker from plain text; strip it from display).
See `docs/learnings/model-capability-fallbacks.md`.
**Build checklist:**
- [ ] `cascade.toolCallStrategy` setting (`native` | `structured` | `react`) + optional capability auto-detect.
- [ ] `StructuredToolStrategy`: send tools as a JSON-schema `response_format`; prompt the model to emit a
      tool-call object; parse it and **yield the same `tool_use` StreamEvents**.
- [ ] `ReActToolStrategy`: inject tool descriptions into the system prompt; parse the text stream for
      `<tool_call>{…}</tool_call>`; yield `tool_use` StreamEvents; strip markers from the displayed text.
- [ ] Forgiving parsing + retries; rely on `maxTurns`. Keep the loop/tools/UI unchanged (the proof).
- [ ] `docs/adr/ADR-021-tool-call-strategies.md` + `docs/guide/phase-13.md`.
**Test queries:** point `cascade.model` at a **non-tool** Ollama model; with `structured` and then `react`
strategy, "Read package.json and tell me the name" still triggers a Read and answers — via the fallback.
**✅ Self-check:** *Why did adding two new tool-calling strategies require zero changes to `runAgentLoop`?*

---

## Documentation Deliverables
- `cascade/docs/adr/ADR-0XX-*.md` — one per ADR (incl. the two divergences 013/014).
- `cascade/docs/guide/phase-0X.md` — per-phase guide (this curriculum expanded; checkboxes + test queries + self-check).
- `cascade/docs/architecture.md` — living overview + the canonical mapping table.
- `cascade/README.md` — build, run (F5), point at Ollama, current phase.

## Verification
Each phase is verified by **running the extension** (F5 → Extension Development Host), opening Cascade,
and issuing the phase's **two test queries** against a live Ollama. A phase is done only when both pass,
the **self-check** is answerable, and the code is committed/tagged. Test queries are cumulative smoke
tests. Ollama must be running with a tool-capable model.

## Notes / Constraints
- No third-party source is copied. Cascade is independently written, Ollama-native,
  and diverges deliberately on MCP timing (background discovery + lazy retry). Display streams prose+thinking live with an
  activity view (ADR-013) — the common approach, not a divergence.
- **One engine, many frontends.** `@cascade/core` is headless (no `vscode`, no DOM). The extension drives
  it in-process; the web app drives it over WebSocket via `@cascade/server`. The `ActivityEvent` protocol
  is the only thing crossing any boundary — that is what makes the frontends interchangeable.
- Build strictly in order; every phase is a runnable checkpoint. Phases 1–11 grow the core (driven by the
  extension); Phase 12 adds the server + web frontend on the same engine.
- The canonical mapping table is the anti-drift anchor — update it whenever a module is added or renamed.

## North Star (future — NOT current scope)
Once the coding agent is built and tested, the longer-term aim is to use `@cascade/core` as the **backend
engine for a prompt-to-app builder** — a web (and/or desktop) product where users build whole
apps from prompts, via its own frontend wrapper + app-scaffolding pre-prompts/tools/templates on the same
engine. **Deferred — do not build toward it now;** finish + validate the agent first. Recorded because it's
*why* the core is headless + frontend-agnostic (ADR-018) + provider-agnostic (ADR-020): an app-builder
product is "a new frontend + prompt/tool pack on Cascade," not a rewrite.
