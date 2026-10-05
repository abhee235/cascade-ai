// projectManager.ts — the server's stateful core (Phase 13.2).
//
// A *project* is a workspace dir on the host plus its own long-lived CascadeSession. The manager OWNS
// these sessions, keyed by project id — they outlive any single WebSocket connection, so a project's
// conversation survives you closing the browser tab and coming back. A connection merely *attaches* to a
// project (see wsServer.ts). It is a server-side session registry: sessions are decoupled from the
// client transport.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProvider, createSession, JsonlTracer, type AgentDef, type CascadeSession, type Sandbox, type Tracer } from '@cascade/core'
import { fanout, OtelTracer, type NestableTracer } from './otelTracer.js'
import type { ProjectInfo } from '@cascade/app-protocol'
import { applyTemplate, readAiRules, stampStart } from './templates.js'
import { needsPlanStage } from './planStage.js'
import { agentDirsFor, builderSessionOptions, plannerSessionFor } from './builderSession.js'
import { hasVision } from './modelCaps.js'
import type { ProjectRuntime } from './projectRuntime.js'

/** Initialize a git repo in `dir` with one commit — the baseline for checkpoints (Phase 18). Best-effort. */
function gitInit(dir: string): void {
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Cascade', '-c', 'user.email=cascade@local', 'commit', '-q', '-m', 'Initial commit from template'], { cwd: dir, stdio: 'ignore' })
  } catch {
    /* git missing or nothing to commit — don't fail project creation */
  }
}

/** Internal record: the public ProjectInfo + the host dir + the lazily-created session & sandbox. */
type Project = ProjectInfo & { dir: string; session?: CascadeSession; sandbox?: Sandbox }

export interface ProjectManagerOptions {
  /** Host dir under which each project gets its own subdir. */
  root: string
  /** Provider id for createProvider ("ollama" | "openai" | "nvidia" | any OpenAI-compat id). Default "ollama". */
  provider?: string
  model: string
  baseUrl?: string
  /** Explicit API key; usually omitted — the factory resolves OPENAI_API_KEY/NVIDIA_API_KEY/… from env. */
  apiKey?: string
  /** Override the context window (tokens) for compaction sizing. For hosted providers there's no live probe
   *  (detectModelLimits is Ollama-only), so this is how a user corrects the model→window map when their NIM
   *  endpoint serves a different window than the model's native max. Omit ⇒ the map, then DEFAULT_WINDOW. */
  contextWindow?: number
  /** Compaction trigger as a fraction of the window (core default 0.7). A HARDWARE knob, not just a context
   *  one: measured 2026-07-23 (qwen36 on 16GB, partial offload), decode fell 48→31 tok/s as context grew to
   *  90k with compaction never firing (0.7×131k=91k just out of reach). Lower it (e.g. 0.5) on offloaded
   *  setups so the working context stays in the fast range and any full re-prefill is proportionally cheaper. */
  compactRatio?: number
  /** Build a per-project execution sandbox (13.3). The default wiring passes a DockerSandbox when Docker is
   *  available; tests pass none (host exec). The manager owns the sandbox lifecycle (disposed with the project). */
  sandboxFor?: (dir: string) => Sandbox | undefined
  /** How to build a project's session. Injected so tests can pass a FakeProvider. Default: an Ollama-backed
   *  session rooted at the project dir, with the project's sandbox (if any) + AI rules injected. */
  createSessionFor?: (dir: string, sandbox?: Sandbox, extraInstructions?: string) => CascadeSession
  /** How to build a plan-stage session (ADR-056 rung 3). Injected for tests; default: planStage.ts. */
  createPlanSessionFor?: (dir: string, def: AgentDef, sandbox?: Sandbox) => CascadeSession
  /** How to construct a ModelProvider. Injected for tests so they can assert WHICH provider/model a session
   *  was built from — the plan stage silently used the env default for a while (see planSessionFor). */
  createProviderFn?: typeof createProvider
  /** ADR-071: the ENABLED MCP servers to give each new session, read fresh (a thunk, so a config change +
   *  session-invalidation is picked up on the next open). Undefined ⇒ no MCP. */
  mcpServers?: () => Record<string, import('@cascade/core').McpServerConfig>
  /** ADR-071: how to connect an MCP server (the real stdio adapter is `sdkConnect`; injected for tests). */
  mcpConnect?: import('@cascade/core').McpConnect
  /** ADR-081: an EXTRA tracer to fan the session's event stream into, built by the deployment's
   *  composition root (desktop: the SQLite span store behind the Observatory). Injected rather than
   *  constructed here so the server never learns which storage backend it got — see the boundary test.
   *  Called once per session; returning undefined simply leaves the fanout as it was. */
  sessionTracerFor?: SessionTracerFactory
}

/** Builds the per-session extra tracer.
 *  - `projectId`, NOT the host dir — and the dir is deliberately not offered. Spans written here are read
 *    back by a client, where a host path must never appear (see ProjectInfo); passing the dir would put a
 *    leak one keystroke away, and a dir is meaningless to a hosted adapter anyway.
 *  - `model` because a span's model is the one that ANSWERED, and the active selection changes at
 *    runtime (ADR-067), so it can't be captured once at startup. */
export type SessionTracerFactory = (info: { projectId?: string; kind: 'builder' | 'planner'; model?: string }) => Tracer | undefined


/** name → a filesystem-safe slug (so dirs are readable); id keeps them unique. */
const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project'

export { agentDirsFor, BUILDER_BEHAVIOR, skillDirsFor } from './builderSession.js' // moved (ADR-085 P0); re-exported for existing importers

/** Per-project forensic traces (ADR-023, product path — the first live walkthrough was UNDIAGNOSABLE
 *  without them). One JSONL per session under the project's own .cascade/traces/.
 *
 *  ADR-053 (amended): when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, the SAME event stream also goes live
 *  to an OTLP viewer (Phoenix: http://localhost:6006/v1/traces), so a build is browsable WHILE it runs
 *  instead of only after replaying its .jsonl with otelBackfill.mts. Unset ⇒ byte-identical to before:
 *  no exporter, no timers, no network. The JSONL stays the source of truth either way — it is written
 *  first in the fanout, so a viewer being down can never cost you the forensic record. */
const otelTracers = new Map<string, OtelTracer>() // one exporter per project+kind; a new one per turn would leak timers
const traceSessions = new Map<string, string>() // project dir → the chat its spans should be grouped under

/** ADR-053: group a project's turns into ONE conversation in the viewer (Phoenix Sessions / `session.id`).
 *  Every submit is its own trace by design, so without this a build and its follow-ups arrive as unrelated
 *  traces. Called per submit with the chat the turn is pinned to; the planner and builder share it, so a
 *  fresh project's plan stage and the build it feeds group together instead of looking like two jobs. */
/** Push whatever is still buffered to the viewer. BatchSpanProcessor holds spans for seconds, so without
 *  this every shutdown — including each `tsx watch` restart in dev, which happens constantly — silently drops
 *  the tail of the session. Best-effort and bounded: exiting must not hang on an unreachable collector. */
export async function flushTracers(timeoutMs = 2_000): Promise<void> {
  const tracers = [...otelTracers.values()]
  if (!tracers.length) return
  // CLOSE, then flush — in that order, and never one without the other. Flushing an in-flight turn pushes
  // nothing, because an unended span is never exported: the turn doesn't arrive truncated, it doesn't arrive.
  for (const t of tracers) t.endOpenSpans('server shutdown')
  const flushed = tracers.map((t) => t.forceFlush().catch(() => {}))
  await Promise.race([Promise.allSettled(flushed), new Promise((r) => setTimeout(r, timeoutMs))])
}

/** Extra (deployment) tracers by `dir:kind`, so a chat switch reaches them the same way it reaches the
 *  OTLP exporter. Duck-typed on `setSession`: a sink that doesn't care about chats simply won't have it. */
const extraTracers = new Map<string, { setSession?: (id: string | undefined) => void }>()
/** The BUILDER tracer per project dir. The orchestrated plan stage nests inside its turn rather than
 *  opening a trace of its own (ADR-081 amendment) — which needs a handle on the turn's owner. */
const builderTracers = new Map<string, NestableTracer>()

export function setTraceSession(dir: string, chatId: string | undefined): void {
  if (chatId) traceSessions.set(dir, chatId)
  else traceSessions.delete(dir)
  for (const kind of ['builder', 'planner'] as const) {
    otelTracers.get(`${dir}:${kind}`)?.setSession(chatId)
    extraTracers.get(`${dir}:${kind}`)?.setSession?.(chatId)
  }
}
/** Open the turn's root span BEFORE the plan stage runs, so the planner has a parent to nest under.
 *  No builder tracer (a fresh project whose session isn't built yet) ⇒ a no-op, and the builder's own
 *  submit opens the root as it always did. */
export function beginTurn(dir: string, text: string): void {
  builderTracers.get(dir)?.beginTurn(text)
}

/** A tracer for a sub-agent of the current turn — its root becomes a CHILD AGENT span. Undefined when
 *  no builder tracer exists, and the caller then falls back to a standalone tracer. */
export function subAgentTracer(dir: string, name: string): Tracer | undefined {
  return builderTracers.get(dir)?.subAgent(name)
}

export const tracerFor = (dir: string, kind: 'builder' | 'planner', extra?: Tracer): Tracer => {
  const jsonl = new JsonlTracer(join(dir, '.cascade', 'traces', `${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`))
  // JSONL stays FIRST in every fanout: it is the forensic record, and neither a viewer being down nor a
  // storage adapter throwing may cost us it.
  const tracers: Tracer[] = [jsonl]
  if (extra) {
    extraTracers.set(`${dir}:${kind}`, extra as { setSession?: (id: string | undefined) => void })
    // A tracer born mid-submit (the planner's, created after setTraceSession has already run) must adopt
    // the chat in flight, or its spans land outside the conversation they belong to.
    ;(extra as { setSession?: (id: string | undefined) => void }).setSession?.(traceSessions.get(dir))
  }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const remember = (t: NestableTracer) => {
    if (kind === 'builder') builderTracers.set(dir, t)
    return t
  }
  if (!endpoint) return remember(fanout(jsonl, ...(extra ? [extra] : [])))
  const key = `${dir}:${kind}`
  let otel = otelTracers.get(key)
  if (!otel) {
    otel = new OtelTracer({
      endpoint,
      service: `cascade-${kind}:${basename(dir)}`,
      kind, // names the root: a fresh project's first prompt shows as `agent (planner)` then `agent (builder)`

      project: process.env.PHOENIX_PROJECT_NAME, // unset ⇒ the viewer's default bucket (shared with eval runs)
      attributes: { 'cascade.project': basename(dir), 'cascade.session_kind': kind },
    })
    otelTracers.set(key, otel)
  }
  // The PLANNER's tracer is created mid-submit — after setTraceSession has already run — so a tracer born
  // now must adopt the session in flight, or the plan stage lands outside the conversation it belongs to.
  otel.setSession(traceSessions.get(dir))
  tracers.push(otel)
  if (extra) tracers.push(extra)
  return remember(fanout(...tracers))
}

export class ProjectManager {
  private readonly projects = new Map<string, Project>()
  private readonly createSessionFor: (dir: string, sandbox?: Sandbox, extraInstructions?: string) => CascadeSession
  private readonly metaFile: string

  /** ADR-060: does the configured model report `vision`? Resolved once in the background at construction —
   *  session factories are sync, and the answer is stable for a server's lifetime. Until it resolves the
   *  flag is false, so a session created in the first second simply doesn't get the Browser tool (inert
   *  default; the next session will). */
  private visionOk = false

  /** ADR-067: the RUNTIME provider/model config. Starts from opts (env), mutated by setModelConfig so the
   *  UI can switch provider+model WITHOUT restarting the server. New sessions read this; switching
   *  invalidates cached sessions (history lives in chatStore and reloads on re-open). */
  private active!: { provider: string; model: string; baseUrl?: string; apiKey?: string; api?: 'openai' | 'ollama'; contextWindow?: number; maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number; repeatPenalty?: number; presencePenalty?: number; thinking?: 'off' | 'low' | 'medium' | 'high' }
  /** Provider construction, injectable so tests can assert which model a session was actually built from. */
  private readonly makeProvider: typeof createProvider

  constructor(private readonly opts: ProjectManagerOptions) {
    mkdirSync(opts.root, { recursive: true })
    this.metaFile = join(opts.root, 'projects.json')
    this.active = { provider: opts.provider ?? 'ollama', model: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKey, contextWindow: opts.contextWindow }
    this.makeProvider = opts.createProviderFn ?? createProvider
    void hasVision(this.active.model, this.active.baseUrl, this.active.provider).then((v) => {
      this.visionOk = v
    })
    this.createSessionFor =
      opts.createSessionFor ??
      ((dir, sandbox, extraInstructions) =>
        createSession(
          builderSessionOptions({
            dir,
            sandbox,
            extraInstructions,
            provider: this.makeProvider({ provider: this.active.provider, model: this.active.model, baseUrl: this.active.baseUrl, apiKey: this.active.apiKey, api: this.active.api }),
            active: this.active,
            vision: this.visionOk,
            compactRatio: this.opts.compactRatio,
            mcpServers: this.opts.mcpServers?.(),
            mcpConnect: this.opts.mcpConnect,
            tracer: tracerFor(dir, 'builder', this.opts.sessionTracerFor?.({ projectId: this.idOfDir(dir), kind: 'builder', model: this.active.model })),
          }),
        ))
    this.load()
  }

  /** ADR-056 rung 3: the plan stage. If this project's NEXT submit is the first message of a fresh,
   *  unplanned project (and a proactive planner is mounted), build the planner's one-shot TOP-LEVEL
   *  session. The caller runs it to completion (PLAN.md lands on disk), disposes it, then submits the
   *  user's message to the builder as usual. Undefined ⇒ no stage. */
  planSessionFor(id: string): CascadeSession | undefined {
    const project = this.projects.get(id)
    if (!project?.session) return undefined // not open()ed — the submit path always opens first
    const def = needsPlanStage(project.dir, project.session.getHistory().length, agentDirsFor(project.dir))
    if (!def) return undefined
    const build =
      this.opts.createPlanSessionFor ??
      ((dir: string, d: AgentDef, sandbox?: Sandbox) =>
        plannerSessionFor(d, {
          dir,
          // ADR-067: the ACTIVE selection, NOT `opts` (the env seed). Measured 2026-07-22: with the picker on
          // a local Ollama model, the plan stage still ran its whole pass on CASCADE_MODEL — Ollama's request
          // log shows zero calls for the 56s the planner spent making 10 model calls to the hosted default.
          // Silent, billed, and invisible except in a per-message label.
          provider: this.makeProvider({ provider: this.active.provider, model: this.active.model, baseUrl: this.active.baseUrl, apiKey: this.active.apiKey, api: this.active.api }),
          active: this.active,
          sandbox,
          // ADR-081 amendment: the plan stage is a SUB-AGENT of this turn, not a turn of its own. One
          // user message, one trace — the planner's root becomes a child AGENT span inside the builder's,
          // which is what OTel's GenAI conventions describe for a same-process agent invocation and what
          // a model-invoked `Subagent {agent:"planner"}` already does. Falls back to a standalone tracer
          // if no builder tracer exists (the eval bench builds plan sessions directly).
          tracer:
            subAgentTracer(dir, 'agent (planner)') ??
            tracerFor(dir, 'planner', this.opts.sessionTracerFor?.({ projectId: this.idOfDir(dir), kind: 'planner', model: this.active.model })),
        }))
    return build(project.dir, def, project.sandbox)
  }

  /** The host dir of a project — SERVER-INTERNAL only (never crosses the wire). For the file service. */
  dirOf(id: string): string | undefined {
    return this.projects.get(id)?.dir
  }

  /** The inverse of dirOf. The session factories are handed a `dir` (that is what a session is rooted at),
   *  but anything that will reach a client — a span's project stamp — must carry the ID instead. Linear,
   *  and it runs once per session creation, not per event. */
  private idOfDir(dir: string): string | undefined {
    for (const p of this.projects.values()) if (p.dir === dir) return p.id
    return undefined
  }

  /** ADR-071: drop cached sessions so the next open() rebuilds with fresh config (e.g. after an MCP server is
   *  added/removed). Same mechanism setModelConfig uses; exposed so the MCP panel can apply changes live. */
  async invalidateSessions(): Promise<void> {
    for (const p of this.projects.values()) {
      await p.session?.dispose().catch(() => {})
      p.session = undefined
    }
  }

  /**
   * ADR-081 §4: drop every cached SANDBOX (and the sessions holding them) so the next open() rebuilds
   * against the current runtime mode.
   *
   * Disposal is not optional here and it is not the same as invalidateSessions: a Docker sandbox owns a
   * container and a host sandbox owns a detached dev server. Dropping the reference without disposing
   * leaks both — the container keeps running (it is kept alive by `tail -f`, so nothing reaps it) and the
   * dev server keeps holding the port the new runtime is about to ask for.
   */
  async invalidateSandboxes(): Promise<void> {
    for (const p of this.projects.values()) {
      await p.session?.dispose().catch(() => {})
      p.session = undefined
      await p.sandbox?.dispose().catch(() => {})
      p.sandbox = undefined
    }
  }

  /** Live MCP connection statuses. Prefer the active project's session; else ANY open session — they all
   *  connect the SAME global config, so any one's status is representative. This lets the standalone
   *  Connectors page show real status even though it isn't scoped to a project. [] if nothing is open. */
  mcpStatuses(activeId: string | undefined): import('@cascade/core').McpServerStatus[] {
    const active = activeId ? this.projects.get(activeId)?.session?.mcpStatuses() : undefined
    if (active?.length) return active
    for (const p of this.projects.values()) {
      const st = p.session?.mcpStatuses()
      if (st?.length) return st
    }
    return []
  }

  /** The project's sandbox (created on open) — SERVER-INTERNAL. For live preview (the dev server runs in it). */
  sandboxOf(id: string): Sandbox | undefined {
    return this.projects.get(id)?.sandbox
  }

  /** The project's sandbox IF it also satisfies the preview contract (ADR-081 §4).
   *
   *  A structural narrowing rather than a cast: core's `Sandbox` is deliberately minimal, and a
   *  deployment is free to inject one that only runs commands. Such a deployment gets no live preview,
   *  which is the correct answer — better than a cast that pretends the methods are there and throws
   *  when the user presses Run. */
  runtimeOf(id: string): ProjectRuntime | undefined {
    const sandbox = this.projects.get(id)?.sandbox
    return sandbox && 'kind' in sandbox ? (sandbox as ProjectRuntime) : undefined
  }

  /** Public, host-path-free snapshot for the sidebar. */
  list(): ProjectInfo[] {
    return [...this.projects.values()]
      .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Create a new project: a dir on disk (optionally scaffolded from a template + git-init'd) + a metadata
   *  record. The session is NOT built until open(). */
  create(name: string, templateId?: string): ProjectInfo {
    const id = randomUUID()
    const dir = join(this.opts.root, `${slug(name)}-${id.slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    if (templateId === 'none') {
      // ADR-086 blank start: no scaffold. A .gitignore only, so the baseline commit exists and the builder's
      // own `npm install` / build output never land in the user's history; the stamp picks the free profile.
      writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n')
      stampStart(dir, 'none')
      gitInit(dir)
    } else if (templateId) {
      applyTemplate(templateId, dir) // copy the scaffold (Vite+React+TS+Tailwind, etc.)
      stampStart(dir, 'react')
      gitInit(dir) // baseline commit for future checkpoints (Phase 18)
    }
    const project: Project = { id, name: name.trim() || 'Untitled', createdAt: new Date().toISOString(), dir }
    this.projects.set(id, project)
    this.save()
    return { id: project.id, name: project.name, createdAt: project.createdAt }
  }

  /** The active provider/model (for the serverInfo greeting + the UI's picker). */
  get currentProvider(): string {
    return this.active.provider
  }
  /** Does the active model accept images? (ADR-086: the plan stage only hands images to a model that can see them.) */
  get vision(): boolean {
    return this.visionOk
  }
  get currentModel(): string {
    return this.active.model
  }

  /** ADR-067: switch the active provider/model at RUNTIME (no server restart). Invalidates every cached
   *  session so the next open() rebuilds with the new provider; conversation history lives in chatStore and
   *  reloads on re-open. The API key is resolved from the ENVIRONMENT for the built-in providers, OR passed
   *  explicitly (ADR-076: a custom endpoint's key, held server-side in the registry, never by the client).
   *  On a provider change, the old baseUrl/contextWindow/apiKey are dropped (provider-specific) unless supplied. */
  async setModelConfig(cfg: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; api?: 'openai' | 'ollama'; contextWindow?: number; maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number; repeatPenalty?: number; presencePenalty?: number; thinking?: 'off' | 'low' | 'medium' | 'high' }): Promise<void> {
    const providerChanged = !!cfg.provider && cfg.provider !== this.active.provider
    const modelChanged = !!cfg.model && cfg.model !== this.active.model
    // Per-model params (window/output/sampling) are dropped when the TARGET model changes — the caller
    // (wsServer.setModel) re-supplies the new model's saved params from the registry. A same-model tweak
    // (setModelParams) keeps whatever it doesn't override.
    const dropModelParams = providerChanged || modelChanged
    this.active = {
      provider: cfg.provider ?? this.active.provider,
      model: cfg.model ?? this.active.model,
      baseUrl: cfg.baseUrl ?? (providerChanged ? undefined : this.active.baseUrl),
      apiKey: cfg.apiKey ?? (providerChanged ? undefined : this.active.apiKey), // ADR-076: honor an explicitly-supplied key (custom endpoint), not just the carried-over one
      api: cfg.api ?? (providerChanged ? undefined : this.active.api), // ADR-077: the endpoint's wire protocol travels with it
      contextWindow: cfg.contextWindow ?? (dropModelParams ? undefined : this.active.contextWindow),
      maxOutputTokens: cfg.maxOutputTokens ?? (dropModelParams ? undefined : this.active.maxOutputTokens),
      temperature: cfg.temperature ?? (dropModelParams ? undefined : this.active.temperature),
      topP: cfg.topP ?? (dropModelParams ? undefined : this.active.topP),
      topK: cfg.topK ?? (dropModelParams ? undefined : this.active.topK),
      repeatPenalty: cfg.repeatPenalty ?? (dropModelParams ? undefined : this.active.repeatPenalty),
      presencePenalty: cfg.presencePenalty ?? (dropModelParams ? undefined : this.active.presencePenalty),
      thinking: cfg.thinking ?? (dropModelParams ? undefined : this.active.thinking),
    }
    this.visionOk = await hasVision(this.active.model, this.active.baseUrl, this.active.provider).catch(() => false)
    // Drop cached sessions so the next open() recreates them against the new provider (history reloads).
    // NOT awaited (2026-07-26): dispose() runs session-end curation — a local-model side-query that can take
    // minutes — and awaiting it here blocked the entire model switch behind it (a dev restart in that window
    // lost the switch). dispose() aborts any in-flight turn synchronously at its first line; the slow curation
    // tail can finish in the background while the new provider takes over.
    for (const p of this.projects.values()) {
      void p.session?.dispose().catch(() => {})
      p.session = undefined
    }
  }

  /** Attach to a project: lazily build (and cache) its sandbox + session on first open. Throws if unknown. */
  open(id: string): CascadeSession {
    const project = this.projects.get(id)
    if (!project) throw new Error(`No such project: ${id}`)
    if (!project.session) {
      project.sandbox = this.opts.sandboxFor?.(project.dir)
      // Read the template's AI rules FRESH (the agent may edit them) and inject as system-prompt context.
      project.session = this.createSessionFor(project.dir, project.sandbox, readAiRules(project.dir))
    }
    return project.session
  }

  /** Delete a project: tear down its session + sandbox and remove its dir. */
  async delete(id: string): Promise<void> {
    const project = this.projects.get(id)
    if (!project) return
    await project.session?.dispose()
    await project.sandbox?.dispose()
    this.projects.delete(id)
    rmSync(project.dir, { recursive: true, force: true })
    this.save()
  }

  /** Dispose every live session + sandbox (server shutdown). Dirs stay on disk. */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.projects.values()].flatMap((p) => [p.session?.dispose(), p.sandbox?.dispose()]),
    )
  }

  // ── persistence: only metadata, never sessions ──────────────────────────────────────────
  private load(): void {
    if (!existsSync(this.metaFile)) return
    try {
      const rows = JSON.parse(readFileSync(this.metaFile, 'utf8')) as Project[]
      for (const r of rows) if (existsSync(r.dir)) this.projects.set(r.id, { ...r, session: undefined })
    } catch {
      /* corrupt metadata → start empty rather than crash */
    }
  }

  private save(): void {
    const rows = [...this.projects.values()].map(({ id, name, createdAt, dir }) => ({ id, name, createdAt, dir }))
    writeFileSync(this.metaFile, JSON.stringify(rows, null, 2))
  }
}
