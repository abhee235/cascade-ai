// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//

// Phase 3: the session now keeps conversation HISTORY (a Message[]) and a system prompt. The model is
// stateless — "memory" is just us resending the whole transcript every turn. submit() appends the user
// turn, streams the reply (forwarding deltas live — ADR-013), then appends the assistant turn.

import type { ActivityEvent, ContentBlock, Message } from './protocol'
import type { ModelProvider } from './llm/provider'
import { runAgentLoop } from './agent/agentLoop'
import { gatherProjectContext } from './agent/projectContext'
import { resolveCheckCommand, type CheckCommand } from './agent/verifyGate'
import type { PermissionController, PermissionMode, PermissionState } from './permissions/gate'
import { NoopTracer, type Tracer } from './observability/tracer'
import { join } from 'node:path'
import { createRegistry, registryOf } from './tools/toolRegistry'
import { scopeToolsByGrants } from './tools/toolGrants'
import { FileStateCache } from './tools/fileState'
import { TodoStore } from './tools/todoStore'
import { McpHub, type McpServerConfig, type McpConnect, type McpServerStatus } from './mcp/mcpHub'
import { createArchival, type ArchivalHit } from './memory/archival'
import { loadMemory } from './memory/memoryStore'
import { resolveCompactionPlan } from './context/compactor'
import { curateMemory } from './memory/curator'
import { loadHooksConfig } from './hooks/hookRunner'
import { createSkillTool, loadSkills, skillsPromptSection } from './skills/skills'
import { agentsPromptSection, loadAgentDefs } from './agent/agentDefs'

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
  /** Restrict the session to EXACTLY these tools (same shape as AgentDef.tools — a persona run as a
   *  top-level session, e.g. the server's plan stage). Absent ⇒ full registry. Generic mechanism: core
   *  doesn't know WHY a caller narrows the set. */
  tools?: string[]
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
  /** ADR-056 rung 5: files pinned into the system prompt, re-read FRESH each turn (like memory) so their
   *  content is always present + current, never compacted, never dependent on the model choosing to Read.
   *  The builder pins PLAN.md (the durable contract that must survive compaction across iterate rounds). */
  contextFiles?: string[]
  /** Max model round-trips per submit before the loop stops (default 10). A builder doing a full app
   *  needs far more than a chat turn — the server sets this high. */
  maxTurns?: number
  /** ADR-049: refuse a terminal answer when files were edited but nothing verified them (one nudge turn,
   *  then accept). Default true. */
  verifyGate?: boolean
  /** ADR-051: the command that defines "done" for this session (eval runner / web builder pass it). When
   *  set, the verify gate names it in a DIRECTIVE nudge, allows two strikes, and holds even no-edit terminal
   *  answers to it. When absent, the session may still resolve `npm test` from package.json for the nudge
   *  TEXT — but firing semantics stay exactly ADR-049 (chat over a repo with tests is still chat). */
  checkCommand?: string
  /** ADR-050: remind the model once to delegate when bulk reads dominate the window. Default true. */
  delegateNudge?: boolean
  /** ADR-036: load `.cascade/hooks.json` from the project (default true). Frontends MUST pass false when the
   *  cwd is MODEL-WRITABLE and untrusted (the server's sandboxed builder projects): hook commands spawn on the
   *  HOST, so a model-written hooks.json would otherwise escalate out of the sandbox at the next open(). */
  loadProjectHooks?: boolean
  /** ADR-055: skill directories, IN ORDER — later dirs shadow earlier ones by name. Pass base (server-owned,
   *  immutable — they live OUTSIDE the project and the Read jail) dirs first and user dirs last. The session
   *  loads them once, advertises a one-line index in the system prompt, and serves bodies via the Skill tool. */
  skillDirs?: string[]
  /** ADR-056: named-agent definition directories, same ordering/shadowing rules as skillDirs. Each *.md is a
   *  persona (frontmatter contract + body = its system prompt) the model spawns via Subagent {agent: name}. */
  agentDirs?: string[]
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
  // The park also watches the turn's abort signal: abort() may run while the generator is still suspended at
  // the `question` YIELD (before request() executes), so draining pendingAnswers alone races — the request
  // itself must observe the abort and resolve with no answers (the aborted turn unwinds before they're read).
  const pendingAnswers = new Map<string, (a: import('./protocol').Answers) => void>()
  const ask: import('./tools/Tool').AskController = {
    request: (id) =>
      new Promise((resolve) => {
        pendingAnswers.set(id, resolve)
        const sig = inFlight?.signal
        const onAbort = () => {
          if (pendingAnswers.delete(id)) resolve({})
        }
        if (sig?.aborted) onAbort()
        else sig?.addEventListener('abort', onAbort, { once: true })
      }),
  }
  const tracer = opts.tracer ?? NoopTracer
  // ADR-032: read-before-edit freshness, session-scoped — a file Read in one turn stays editable in a later
  // one. Read records {content, mtime}; Edit/Write refuse a file with no entry or one that's gone stale.
  const readFileState = new FileStateCache()
  // ADR-034: the authoritative todo checklist, persisted to .cascade/todos.json so it survives compaction and a
  // restart and feeds the loop's periodic reminder. Session-scoped, keyed by agent depth.
  // ADR-036: project hooks (.cascade/hooks.json) — loaded once; null (absent/invalid) = zero code path.
  // Skipped entirely when the frontend marks the cwd untrusted (loadProjectHooks: false — see SessionOptions).
  const hooksConfig = opts.loadProjectHooks === false ? undefined : (loadHooksConfig(opts.cwd) ?? undefined)
  // ADR-051: the check that defines "done". Declared (frontend/eval) beats resolved (package.json); the
  // distinction matters — only a DECLARED check hardens the gate's firing conditions (see verifyGate.ts).
  const check: CheckCommand | undefined = opts.checkCommand
    ? { command: opts.checkCommand, declared: true }
    : (() => {
        const resolved = resolveCheckCommand(opts.cwd)
        return resolved ? { command: resolved, declared: false } : undefined
      })()
  const todoStore = new TodoStore(join(opts.cwd, '.cascade', 'todos.json'))

  // MCP (Phase 9): build the hub from config and start connecting in the BACKGROUND (non-blocking) so
  // tools are discovered without freezing startup. The registry is builtins + whatever is `ready` now —
  // it's a function, so newly-connected MCP tools appear automatically.
  const hub = opts.mcpServers && opts.mcpConnect ? new McpHub(opts.mcpServers, opts.mcpConnect) : undefined
  hub?.start()
  // ADR-055: load skills once (base dirs first, user dirs last — later shadows earlier). The Skill tool
  // serves bodies on demand; the loop advertises the one-line index in the system prompt.
  const skills = opts.skillDirs?.length ? loadSkills(opts.skillDirs) : []
  const skillTool = skills.length > 0 ? createSkillTool(skills) : undefined
  // ADR-056: named agents — personas the Subagent tool can spawn ({agent: "planner"}).
  const agentDefs = opts.agentDirs?.length ? loadAgentDefs(opts.agentDirs) : []
  const fullRegistry = createRegistry(() => [...(hub?.readyTools() ?? []), ...(skillTool ? [skillTool] : [])])
  // Session-level allowlist (same mechanism the Subagent path applies from AgentDef.tools): a persona run
  // as its own top-level session gets its declared tools and nothing else — and grants may be arg-scoped
  // (`Write(PLAN.md)`), so a planner literally cannot write code (ADR-056 rung 4).
  const registry = opts.tools?.length ? registryOf(() => scopeToolsByGrants(fullRegistry.list(), opts.tools!)) : fullRegistry

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
  // ADR-038 enforcement: only limits we are CONFIDENT about go on the wire (explicit option or /api/show
  // detection). A static-map guess must NOT be enforced — it could SHRINK a model's real window.
  let confidentLimits: { contextWindow?: number; maxOutputTokens?: number } = { contextWindow: opts.contextWindow, maxOutputTokens: opts.maxOutputTokens }
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
            // WATCHDOG (iterate-5): the summarize call gets the SAME recycle hook as the main model call —
            // an unguarded summarize was how a wedged backend killed whole rounds.
            recover: opts.provider.recover ? () => opts.provider.recover!(opts.model) : undefined,
            // Self-heal visibility (iterate-7): summarize retries land in the trace like the loop's own.
            onRetry: (info) => tracer.event({ t: 'error', message: `recover(compact summarize) attempt ${info.attempt}, wait ${info.delayMs}ms` }),
            // Coupled curation: harvest durable facts from the OLDER messages right before they're summarized away.
            onDiscard: autoMemory ? async (older) => void (await curate(older)) : undefined,
          },
          recovery: opts.recovery,
          sandbox: opts.sandbox,
          readFileState,
          todoStore,
          ask, // ADR-043: AskUserQuestion round-trip
          extraInstructions: opts.extraInstructions,
          contextFiles: opts.contextFiles, // ADR-056 rung 5: pinned files (e.g. PLAN.md), re-read each turn
          projectContext, // ADR-046: dir tree + git status (gathered once above)
          maxTurns: opts.maxTurns,
          verifyGate: opts.verifyGate, // ADR-049 (default on in the loop)
          check, // ADR-051: known check command (declared by the frontend, or resolved from package.json)
          // ADR-055/056: the capabilities index — skills + named agents, one line each (bodies on demand).
          skillsSection:
            [skills.length > 0 ? skillsPromptSection(skills, compactPlan.tier) : '', agentDefs.length > 0 ? agentsPromptSection(agentDefs, compactPlan.tier) : '']
              .filter(Boolean)
              .join('\n\n') || undefined,
          skills, // ADR-056: named agents preload skill BODIES into their child prompts
          agentDefs,
          delegateNudge: opts.delegateNudge, // ADR-050 (default on in the loop)
          hooks: hooksConfig, // ADR-036
          modelLimits: confidentLimits.contextWindow || confidentLimits.maxOutputTokens ? confidentLimits : undefined, // ADR-038 enforcement
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
      // Same for a parked AskUserQuestion (ADR-043): resolve with no answers — the aborted turn unwinds
      // before the model ever sees them. Without this, Stop during a question parks the loop forever.
      for (const [id, resolve] of pendingAnswers) resolve({}), pendingAnswers.delete(id)
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
