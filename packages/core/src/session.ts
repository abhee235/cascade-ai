// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//

// Phase 3: the session now keeps conversation HISTORY (a Message[]) and a system prompt. The model is
// stateless — "memory" is just us resending the whole transcript every turn. submit() appends the user
// turn, streams the reply (forwarding deltas live — ADR-013), then appends the assistant turn.

import type { ActivityEvent, ContentBlock, Message } from './protocol'
import type { ModelProvider } from './llm/provider'
import { runAgentLoop } from './agent/agentLoop'
import { gatherProjectContext } from './agent/projectContext'
import type { PermissionController, PermissionMode, PermissionState } from './permissions/gate'
import { NoopTracer, type Tracer } from './observability/tracer'
import { join } from 'node:path'
import { createRegistry } from './tools/toolRegistry'
import { FileStateCache } from './tools/fileState'
import { TodoStore } from './tools/todoStore'
import { McpHub, type McpServerConfig, type McpConnect, type McpServerStatus } from './mcp/mcpHub'
import { createArchival, type ArchivalHit } from './memory/archival'
import { loadMemory } from './memory/memoryStore'
import { resolveCompactionPlan } from './context/compactor'
import { curateMemory } from './memory/curator'

export interface SessionOptions {
  cwd: string
  provider: ModelProvider
  model: string
  /** How tool calls are gated. The FRONTEND chooses this: 'default' (extension) asks for writes;
   *  'bypass' (sandboxed web) allows everything. Defaults to 'default'. */
  mode?: PermissionMode
  /** Tool names pre-allowed / pre-denied (e.g. from settings). */
  allow?: string[]
  deny?: string[]
  /** Optional forensic trace sink (ADR-023). Omit ⇒ NoopTracer (no output). */
  tracer?: Tracer
  /** MCP servers to register (Phase 9). Connected in the BACKGROUND at startup (ADR-014). */
  mcpServers?: Record<string, McpServerConfig>
  /** How to connect an MCP server. Injected so the real SDK adapter (or a fake) is pluggable. */
  mcpConnect?: McpConnect
  /** Embedding model for archival memory (Phase 10). Default 'nomic-embed-text'. */
  embedModel?: string
  /** Self-curate durable facts into archival memory at the end of each turn (Phase 10). Default true. */
  autoMemory?: boolean
  /** Context window (tokens) for compaction sizing (Phase 11). Overrides the model→window map. */
  contextWindow?: number
  /** Model max output tokens (ADR-039): caps the compaction summary reserve; helps small windows size correctly. */
  maxOutputTokens?: number
  /** Compaction tuning: `compactRatio` is the proportional trigger `pct` in the ADR-039 ladder (default 0.7);
   *  `keepRecentRatio` is the fraction of the effective window kept verbatim (default 0.25). */
  compactRatio?: number
  keepRecentRatio?: number
  /** Resilience tuning (Phase 12): retry/backoff for transient model-call failures. */
  recovery?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> }
  /** Phase 13.3: execution sandbox. When set (the server injects a per-project Docker sandbox), command
   *  tools (Bash) run inside it; when absent, they run on the host (the extension's behavior). */
  sandbox?: import('./sandbox/sandbox').Sandbox
  /** Phase 15: generic extra system-prompt context (e.g. a project template's AI rules). */
  extraInstructions?: string
  /** Max model round-trips per submit before the loop stops (default 10). A builder doing a full app
   *  needs far more than a chat turn — the server sets this high. */
  maxTurns?: number
}

export interface CascadeSession {
  submit(userText: string, images?: string[]): AsyncIterable<ActivityEvent>
  respondPermission(id: string, decision: 'allow' | 'allow-always' | 'deny'): void
  /** ADR-043: deliver the user's answer to a `question` event, waking the parked loop. */
  respondQuestion(id: string, answers: import('./protocol').Answers): void
  abort(): void
  /** Clear conversation history ("New chat"). */
  reset(): void
  /** Snapshot the conversation history (for persisting a chat). */
  getHistory(): Message[]
  /** Replace the conversation history (switching to a saved chat). Does NOT curate — it's a load, not a clear. */
  loadHistory(msgs: Message[]): void
  /** Tear down MCP subprocesses etc. Call when discarding the session. */
  dispose(): Promise<void>
  /** MCP panel (/mcp): current server statuses, and manual connect/disconnect. */
  mcpStatuses(): McpServerStatus[]
  mcpConnect(name: string): void
  mcpDisconnect(name: string): Promise<void>
  /** Memory panel (/memory): the injected core block, the archival list, search, and forget. */
  memoryView(): { core: string; archival: { id: string; text: string; ts: string }[] }
  memorySearch(query: string): Promise<ArchivalHit[]>
  memoryForget(id: string): void
}

export function createSession(opts: SessionOptions): CascadeSession {
  let inFlight: AbortController | undefined
  const messages: Message[] = [] // conversation history; grows every turn (Phase 10 will compact it)

  // Permission plumbing. `pending` holds, per tool-use id, the resolve() of the promise the scheduler is
  // awaiting. respondPermission(id, …) resolves it — that is the moment the parked loop wakes back up.
  const pending = new Map<string, (d: 'allow' | 'allow-always' | 'deny') => void>()
  const state: PermissionState = {
    mode: opts.mode ?? 'default',
    allow: new Set(opts.allow ?? []),
    deny: new Set(opts.deny ?? []),
  }
  const permission: PermissionController = {
    state,
    request: (id) => new Promise((resolve) => pending.set(id, resolve)),
  }
  // ADR-043: AskUserQuestion plumbing — same shape as permissions. `pendingAnswers` holds the resolve() the
  // scheduler is awaiting on a `question` event; respondQuestion(id, answers) resolves it (wakes the loop).
  const pendingAnswers = new Map<string, (a: import('./protocol').Answers) => void>()
  const ask: import('./tools/Tool').AskController = {
    request: (id) => new Promise((resolve) => pendingAnswers.set(id, resolve)),
  }
  const tracer = opts.tracer ?? NoopTracer
  // ADR-032: read-before-edit freshness, session-scoped — a file Read in one turn stays editable in a later
  // one. Read records {content, mtime}; Edit/Write refuse a file with no entry or one that's gone stale.
  const readFileState = new FileStateCache()
  // ADR-034: the authoritative todo checklist, persisted to .cascade/todos.json so it survives compaction and a
  // restart and feeds the loop's periodic reminder. Session-scoped, keyed by agent depth.
  const todoStore = new TodoStore(join(opts.cwd, '.cascade', 'todos.json'))

  // MCP (Phase 9): build the hub from config and start connecting in the BACKGROUND (non-blocking) so
  // tools are discovered without freezing startup. The registry is builtins + whatever is `ready` now —
  // it's a function, so newly-connected MCP tools appear automatically.
  const hub = opts.mcpServers && opts.mcpConnect ? new McpHub(opts.mcpServers, opts.mcpConnect) : undefined
  hub?.start()
  const registry = createRegistry(() => hub?.readyTools() ?? [])

  // Archival (semantic) memory — Tier 2. The embedder is bound to the provider + embed model; if the
  // provider can't embed (or no model), archival quietly degrades to keyword search.
  const embedModel = opts.embedModel ?? 'nomic-embed-text'
  const embed = opts.provider.embed ? (texts: string[]) => opts.provider.embed!(texts, embedModel) : undefined
  const archival = createArchival({ cwd: opts.cwd, embed })

  // Compaction plan (ADR-039): sized once with a SYNC fallback — window via override → model map → default.
  // When the caller didn't pin a window, we refine this on the FIRST turn via provider.detectModelLimits
  // (ADR-038: Ollama /api/show num_ctx) — ground truth beats the static map, which mis-sized coding-qwen36 as
  // 32k. `let` so detection can replace it; the tier it carries also sizes the system prompt + tool descriptions.
  let compactPlan = resolveCompactionPlan({
    model: opts.model,
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens,
    pct: opts.compactRatio,
    keepRecentRatio: opts.keepRecentRatio,
  })
  let windowDetected = false
  async function ensureDetectedPlan(signal?: AbortSignal): Promise<void> {
    if (windowDetected) return
    windowDetected = true // run at most once; on failure the sync fallback plan stands
    if (opts.contextWindow != null || !opts.provider.detectModelLimits) return // explicit override wins
    try {
      const limits = await opts.provider.detectModelLimits(opts.model, signal)
      if (limits.contextWindow) {
        compactPlan = resolveCompactionPlan({
          model: opts.model,
          contextWindow: limits.contextWindow,
          maxOutputTokens: limits.maxOutputTokens ?? opts.maxOutputTokens,
          pct: opts.compactRatio,
          keepRecentRatio: opts.keepRecentRatio,
        })
      }
    } catch {
      /* best-effort — a probe failure keeps the fallback plan */
    }
  }

  // ADR-046: gather the project-context block (directory tree + git status) ONCE, sized to the detected tier,
  // and reuse it for every turn. Runs AFTER ensureDetectedPlan so it uses the real window tier. Best-effort:
  // any failure leaves projectContext undefined and the prompt unchanged.
  let projectContext: string | undefined
  let contextGathered = false
  async function ensureProjectContext(): Promise<void> {
    if (contextGathered) return
    contextGathered = true
    try {
      projectContext = (await gatherProjectContext({ cwd: opts.cwd, tier: compactPlan.tier })) || undefined
    } catch {
      /* best-effort — no project context is fine */
    }
  }

  // Event-driven curation (ADR-015): harvest durable facts when context is about to be discarded — at
  // compaction (the older chunk) and at session end. OPT-IN (autoMemory); consolidates (ADD/NOOP), no firehose.
  const autoMemory = opts.autoMemory === true
  const curate = (msgs: Message[]) =>
    autoMemory && msgs.length
      ? curateMemory({ messages: msgs, provider: opts.provider, model: opts.model, archival })
      : Promise.resolve([] as string[])

  return {
    async *submit(userText: string, images?: string[]): AsyncIterable<ActivityEvent> {
      const controller = new AbortController()
      inFlight = controller
      await ensureDetectedPlan(controller.signal) // ADR-038: size the plan to the model's real window before turn 1
      await ensureProjectContext() // ADR-046: gather the dir tree + git status once (uses the tier from above)

      // Multimodal turn (M11): attach image data-URIs as image blocks alongside the text; otherwise keep the
      // plain-string form (smaller history, unchanged behaviour for the common case).
      const content: string | ContentBlock[] = images?.length ? [{ type: 'text', text: userText }, ...images.map((url) => ({ type: 'image' as const, url }))] : userText
      messages.push({ role: 'user', content }) // append the user turn to history
      tracer.event({ t: 'submit', text: userText })
      hub?.retryFailed() // lazy retry: give a previously-failed server another chance at the start of a turn

      // Proactive retrieval (ADR-015): auto-search archival for this message and inject the relevant hits,
      // so the model ALWAYS sees pertinent past memories without having to call MemorySearch itself.
      let recalled = ''
      try {
        if (archival.count() > 0) {
          const relevant = (await archival.search(userText, 3)).filter((h) => h.score >= 0.45)
          if (relevant.length) recalled = relevant.map((h) => `- ${h.text}`).join('\n')
        }
      } catch {
        /* retrieval is best-effort */
      }

      try {
        // Delegate to the agentic loop. It streams, runs tools, appends results, and loops until
        // the model stops asking for tools — yielding ActivityEvents the whole way (Phase 4).
        yield* runAgentLoop(messages, {
          provider: opts.provider,
          model: opts.model,
          cwd: opts.cwd,
          signal: controller.signal,
          permission,
          tracer,
          registry,
          archival,
          recalled,
          compact: {
            provider: opts.provider,
            model: opts.model,
            plan: compactPlan,
            signal: controller.signal,
            // Coupled curation: harvest durable facts from the OLDER messages right before they're summarized away.
            onDiscard: autoMemory ? async (older) => void (await curate(older)) : undefined,
          },
          recovery: opts.recovery,
          sandbox: opts.sandbox,
          readFileState,
          todoStore,
          ask, // ADR-043: AskUserQuestion round-trip
          extraInstructions: opts.extraInstructions,
          projectContext, // ADR-046: dir tree + git status (gathered once above)
          maxTurns: opts.maxTurns,
        })
      } catch (err) {
        const e = err as { name?: string; message?: string; cause?: { message?: string } }
        const detail = e?.cause?.message ? `${e.message} (${e.cause.message})` : (e?.message ?? String(err))
        const msg =
          e?.name === 'AbortError'
            ? '⏹ Cancelled.'
            : e?.name === 'RecoveryError'
              ? `⚠️ The model call kept failing (${detail}). Is Ollama running and the model "${opts.model}" loaded? You can just try again.`
              : `⚠️ ${detail}`
        tracer.event({ t: 'error', message: msg })
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: msg }] } }
        yield { type: 'turnDone', steps: 0 }
      } finally {
        inFlight = undefined
      }
    },

    respondPermission(id, decision) {
      const resolve = pending.get(id)
      if (resolve) {
        pending.delete(id)
        resolve(decision) // wakes the scheduler awaiting perm.request(id)
      }
    },
    respondQuestion(id, answers) {
      const resolve = pendingAnswers.get(id)
      if (resolve) {
        pendingAnswers.delete(id)
        resolve(answers) // wakes the scheduler awaiting ctx.ask.request(id)
      }
    },

    abort() {
      inFlight?.abort()
      // Unblock any pending permission prompt so the loop can unwind instead of hanging forever.
      for (const [id, resolve] of pending) resolve('deny'), pending.delete(id)
    },

    reset() {
      // Session-end curation: harvest durable facts from the conversation before clearing it (fire-and-forget
      // — New chat shouldn't block on a model call).
      void curate([...messages])
      messages.length = 0
      // Drop any allow-always rules granted DURING the chat so a new chat truly starts fresh (the gate
      // asks again). Mode and the settings-seeded allow/deny rules are preserved — only the runtime
      // "always allow X" grants are forgotten. (Mutate in place: the controller holds `state` by ref.)
      state.allow = new Set(opts.allow ?? [])
      state.deny = new Set(opts.deny ?? [])
    },

    getHistory: () => [...messages],
    loadHistory(msgs) {
      messages.length = 0
      messages.push(...msgs)
    },

    async dispose() {
      await curate([...messages]) // session-end curation (awaitable) before teardown
      await hub?.dispose() // close MCP subprocesses — no zombies (Phase 9 pitfall)
    },

    mcpStatuses: () => hub?.statuses() ?? [],
    mcpConnect: (name) => hub?.connect(name),
    async mcpDisconnect(name) {
      await hub?.disconnect(name)
    },

    memoryView: () => ({
      core: loadMemory(opts.cwd),
      archival: archival.list().map((e) => ({ id: e.id, text: e.text, ts: e.ts })),
    }),
    memorySearch: (query) => archival.search(query, 10),
    memoryForget: (id) => archival.remove(id),
  }
}
