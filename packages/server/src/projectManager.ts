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
import { applyTemplate, readAiRules } from './templates.js'
import { createPlannerSession, needsPlanStage } from './planStage.js'
import { browserHostFor, createBrowserTool } from './browserTool.js'
import { createPackTool } from './packTool.js'
import { createTemplateAuditTool } from './auditTool.js'
import { createRestyleTool } from './restyleTool.js'
import { createImageSearchTool } from './imageSearchTool.js'
import { hasVision } from './modelCaps.js'
import type { ProjectRuntime } from './projectRuntime.js'
import { resourceDir } from './resources.js'

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

/** Builder behavior injected ahead of every project's AI rules (as generic `extraInstructions`). The core
 *  base prompt is concise-chat-tuned, which makes the model explore then stop; the builder needs the opposite:
 *  keep using tools until the whole app is actually built. Kept here (server/wrapper), not in headless core.
 *  Exported so the Tier-3 builder bench runs sessions IDENTICAL to the product's (forensic fidelity). */
// RECOMPOSED 2026-08-11 (prompt-audit findings B–E): one identity, headed subsections each answering one
// question, precedence declared once at the top, emphasis reserved for the few real invariants (uniform
// shouting reads as uniform priority to a weak model), and every rule keeping its measured origin as a
// comment. Imagery-routing DETAIL moved to the design skill (its trigger words already live there); this
// prompt states only the bar. The audit yardstick: every rule lives in the one section whose question it
// answers, and appears exactly once across system prompt + tool descriptions.
export const BUILDER_BEHAVIOR = [
  '# Builder session',
  'This session has a product role that refines the general rules above — where they conflict, this section wins.',
  '',
  'You are the autonomous app builder for a sandboxed project. The deliverable is working files and a green build; the session is pre-authorized, and no one can answer questions mid-build.',
  '',
  '## Pace',
  '- Complete the entire request this turn: create or edit every file needed, tool call after tool call, until it is fully done. A plan or an explanation is not a deliverable — the working files are.',
  // Measured (gpt-oss:20b, 2026-07-24): ended turns asking permission ("if you'd like me to install…"),
  // cited scope ("beyond what can be done in one turn"), treated `tsc: not found` as a blocker.
  '- Never end your turn to ask a question or offer options ("let me know", "shall I…") — a question burns the turn, because nobody is there to answer. Decide and act.',
  // Batch-3 counterweight (critique): unbounded self-heal licensed `npm install <anything>` while the
  // dashboard skill and most PLANs forbid new deps — the collision resolves here, at the rule itself.
  '- Self-heal instead of stalling: something missing (`tsc: not found`, a package, a directory) is a step to fix — restore what the scaffold declares (`npm install`), create the missing file — and continue. A NEW dependency is different: prefer the kit and existing packages, and add one only when nothing in the kit or the packs can do the job.',
  '- Nothing is "too big for one turn" and nothing gets silently downscoped: decompose and keep building until the whole request is done.',
  '- Length belongs in tool calls, not prose: many file edits, minimal commentary. Never paste file contents into the reply — content goes in the file.',
  '',
  '## Context you already have',
  // Measured (gpt-oss:20b, 2026-07-24): read 24 files across 30 turns and wrote ZERO — analysis-paralysis.
  // Batch-3 scoping (critique): the rule was greenfield-shaped; on later turns the codebase IS the truth.
  '- On a fresh build, do not survey the codebase — the pinned skills and PLAN.md are your context; read a file only right before you edit that exact file, and start writing within your first couple of tool calls. On LATER turns of an existing app, the code is the truth and PLAN.md may be stale: Grep/Read what you are about to change, still without broad surveying.',
  // Same run: tried to READ files its own plan says to CREATE (data.ts 4×), looping on ENOENT.
  '- Files your PLAN lists are targets to create, not files to open: a Read answering "does not exist" means Write it now.',
  '- PLAN.md (pinned below) is the contract: build exactly the views, components, and data model it specifies. The line for updating it first: a NEW view, route, or data-model entity goes through Subagent {agent: "planner", prompt: <the request>} (the pinned copy refreshes automatically); anything smaller you build directly.',
  // Batch-3 (critique, demonstrated by a pinned PLAN that hand-rolled view routing beside useHistoryView):
  // the planner cannot see the scaffold, so PLAN sometimes re-invents an existing seam. The seam wins.
  '- If PLAN.md contradicts an existing seam in src/lib (useHistoryView, storage, photos, utils), the SEAM wins — use it, and note the deviation in one line as you build.',
  // Weak models route poorly on categories — the two always-needed skills are mandated, not routed;
  // situational skills carry literal trigger words in the catalog below.
  '- Before your first Write or Edit, load Skill {name: "architecture"} and Skill {name: "design"} — mandatory. Load the situational skills when their trigger words match.',
  // The plan's `category:` token (design-overhaul P3 slice 5) is the routing instruction, and PLAN.md is
  // pinned into EVERY turn — so unlike an inference made once from the brief, it survives compaction.
  '- PLAN.md\'s Design line opens with `category: <commerce|dashboard|landing|app-shell|game|none>`. Load THAT category\'s skill too (unless it is `none`): it carries the view contract the plan was written against, plus `reference/pages.md` — the verbatim source of a full, working page of that kind. When a view fights you, read that page rather than inventing a shape.',
  '',
  '## Architecture and quality',
  // Measured (shop-iterate-1): one ever-growing App.tsx crossed the read cap by round 2 — every later
  // edit fought windowed reads and stale views.
  '- Small components: one concern per file under src/components/, every file under ~150 lines — extract as you go, because a file that outgrows the read window makes every later edit blind. New components ARE the deliverable, never clutter: the general "don\'t create files needlessly" rule applies to configs, scripts, and docs, not to the app you were asked to build.',
  '- The app must look designed, not scaffolded: pages assembled from src/components/blocks, token colors only (no raw bg-white/hex), and real imagery routed per the design skill\'s IMAGERY ROUTING (an emoji is never an image). First impression is part of "done".',
  // ADR-066, measured (gpt-oss:20b): tried `npm run applypack` / `npx @cascade/backend` — mapped the pack
  // to a shell command instead of the provided tool. Say plainly what ApplyPack is.
  '- Persistence is the browser (the src/lib/storage.ts seam) by default. When the user asks for a database, server, or cross-device persistence: load Skill {name: "backend"} and call the ApplyPack tool — it sits in your toolset exactly like Write; it is not a shell command, and hand-writing a server, schema, or migration is never the path.',
  '',
  '## Verifying the running app',
  // Batch-3 (critique): three documents stated "done" at three bars, and the strongest imperative was the
  // weakest bar — a green tsc is fully compatible with a blank page. ONE canonical checklist, stated here.
  // Measured (qwen36-agentic-iq4, builder-shop 2026-08-11): written as a bare name between a backticked
  // SHELL command and a braced TOOL call, "TemplateAudit clean" read as a CLI — the model burned three
  // turns on `npx template-audit`, `npx -y @<some-scope>/template-audit`, `grep -i audit package.json`
  // before finding the tool. Every rung now carries its own call syntax, so the kind is unambiguous.
  '- Done means, in order: `npm run build` green (the declared check) → TemplateAudit {} clean (zero HARD findings — no demo residue, no unreplaced placeholders; it is a TOOL you call, not a shell command) → Browser {op:"open"} loads → Browser {op:"audit"} clean (no invisible content, CSS loaded, no console errors). Then end the turn.',
  // Batch-3 (critique): "only end when green" + "never ask" had no legal exit when green is impossible —
  // which contradicted "Report faithfully". The honest red is that exit; the gates bound the loop anyway.
  '- If the build still fails after 3 distinct fix attempts on the SAME error, stop: report the exact final error, what you tried, and what was completed. An honest red build is a valid ending; a loop is not.',
  // Batch-4 (subagent-critique): the escalation tier above the inline Browser smoke — situational, because
  // a full second-session QA pass on a local model is minutes of cost; and its report is model output.
  '- When your own checks disagree with reality — audit failing twice on the same problem, or the user saying the app looks wrong — spawn Subagent {agent: "smoketester"} for an independent report. Its findings are claims, not evidence: fix the P0s and re-verify them yourself before calling anything done.',
  // A dev server never exits, so a foreground `npm run dev` blocks until the Bash timeout kills it — no
  // port-readiness signal on that path, unlike the Browser tool (detached start + poll).
  '- To see the app run, use Browser {op:"open"} — it starts the dev server detached and port-polled. A foreground `npm run dev` never returns; it can only stall the turn.',
  // Measured (2026-07-25): `pkill -f vite; pkill -f node` SIGTERMed the container including its own
  // tooling (exit 143), then ~100 turns chasing the empty page it had just caused.
  '- No broad process kills (`pkill -f node`, `pkill -f vite`, `killall`): they take down your own tooling and the dev server, and the blank app you then inspect is a bug you created. The harness reaps stale processes for you.',
].join('\n')

/** name → a filesystem-safe slug (so dirs are readable); id keeps them unique. */
const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project'

/** The capability dirs every builder-facing session shares: server-owned base first (immutable), then the
 *  project's own `.cascade/` (user-owned; shadows base by name). One definition — builder, plan stage,
 *  and the eval bench must all see the SAME capabilities. */
export const skillDirsFor = (dir: string) => [resourceDir('skills', 'builder'), join(dir, '.cascade', 'skills')]
export const agentDirsFor = (dir: string) => [resourceDir('agents', 'builder'), join(dir, '.cascade', 'agents')]

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
  private active!: { provider: string; model: string; baseUrl?: string; apiKey?: string; api?: 'openai' | 'ollama'; contextWindow?: number; maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number; repeatPenalty?: number; presencePenalty?: number }
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
        createSession({
          cwd: dir,
          // THE SHARED LAYERS ARE READ-ONLY, AND NOW ACTUALLY ARE. Both directories carried a READ-ONLY
          // comment and nothing else; measured (qwen3.5:9b 2026-08-13) two of three builds rewrote blocks
          // anyway — NavBar/Hero/LogoStrip edited, a DangerZone block invented. Every property that makes
          // a generated app remixable and lintable ("pages COMPOSE frozen blocks") dies silently there,
          // with the build still green. Reads stay open: composing a block requires reading it first.
          frozenPaths: ['src/components/blocks', 'src/components/ui'],
          provider: this.makeProvider({ provider: this.active.provider, model: this.active.model, baseUrl: this.active.baseUrl, apiKey: this.active.apiKey, api: this.active.api }),
          model: this.active.model,
          // Hosted providers have no live window probe — honor an explicit override so the compactor sizes
          // against the NIM endpoint's real window instead of the model→map guess (or the 8k default).
          contextWindow: this.active.contextWindow,
          // ADR-067: per-model output cap + sampling, applied on every turn (providers ignore what they can't use).
          // UNSET means the window-ratio default ('auto' → max(window/8, 2048) capped at 16,384 — core's
          // recommendedMaxOutputTokens), NOT the flat 16,384 the providers fall back to. On small windows
          // the flat cap let a weak model's thinking eat 40% of the context (measured: 16,384 of 40,960),
          // dragging the wire wall and the compaction trigger down with it. An explicit value still wins.
          maxOutputTokens: this.active.maxOutputTokens ?? ('auto' as const),
          temperature: this.active.temperature,
          topP: this.active.topP,
          topK: this.active.topK,
          repeatPenalty: this.active.repeatPenalty,
          presencePenalty: this.active.presencePenalty,
          // The autonomous builder has no synchronous user to answer mid-build — drop AskUserQuestion so a
          // weak model can't stall the turn asking permission / for the next step (it must ACT — see
          // BUILDER_BEHAVIOR). Clarifying questions belong to the planner stage, which keeps the tool.
          // ADR-075: drop Lsp too. Its diagnostics half is redundant (type errors are PUSHED after each edit),
          // and its navigation half went UNUSED across the whole build corpus (0 calls) while adding a
          // false-negative hazard — a weak model that fumbles the required line/column gets "no references
          // found" and can act destructively on that false empty. Push diagnostics, don't offer pull-navigation
          // to the weak builder. The LanguageService ENGINE stays (the harness uses it for the diagnostics push).
          excludeTools: ['AskUserQuestion', 'Lsp'],
          // Hardware knob (2026-07-23): earlier compaction keeps decode fast on offloaded setups — see
          // ProjectManagerOptions.compactRatio for the measured rationale.
          compactRatio: this.opts.compactRatio,
          // ADR-071: MCP servers (web search, etc.) the user configured in the MCP panel. The session builds
          // its own McpHub from these and connects in the background; their tools join the registry. Injected
          // (not read from a file here) so a config change + session-invalidation surfaces on the next open.
          mcpServers: this.opts.mcpServers?.(),
          mcpConnect: this.opts.mcpConnect,
          // Product forensics (walkthrough lesson: no trace = no diagnosis). ADR-081: the deployment's own
          // tracer joins the fanout here — on the desktop that is the SQLite store the Observatory reads.
          tracer: tracerFor(dir, 'builder', this.opts.sessionTracerFor?.({ projectId: this.idOfDir(dir), kind: 'builder', model: this.active.model })),
          // ADR-074: ON. The original OFF had two reasons — (a) curation adds hidden model calls (dead air),
          // (b) recall mutated the system-prompt PREFIX, breaking the KV cache. (b) is now gone: dynamic recall
          // appends surfaced facts at the message TAIL (dynamicRecall.ts), leaving the cached prefix intact, and
          // curation writes to archival never touch the frozen system prompt. That leaves only (a) — curation
          // fires just at compaction (bounded dead air), a trade the user chose: a durable fact recalled once
          // beats re-diagnosing it across a dozen fix-loop turns (the measured Velocarta CTA-colour loop).
          autoMemory: true,
          sandbox, // 13.3: command tools run in the project's sandbox when present
          // Sandboxed ⇒ auto-allow (the builder is contained; it shouldn't prompt for every command/edit).
          // Without a sandbox we keep the default gate (the host is not isolated).
          mode: sandbox ? 'bypass' : 'default',
          // Prepend builder behavior to the template's AI rules. The core base prompt is tuned for concise
          // chat ("short, direct responses"), which makes the model stop after exploring; the builder must
          // instead keep using tools u ntil the whole app is built. This OVERRIDES the concise default.
          extraInstructions: [BUILDER_BEHAVIOR, extraInstructions].filter(Boolean).join('\n\n'),
          // A full build is many model round-trips (one per file batch); the chat default of 10 is far too low.
          // 80 → 500 (2026-07-20): run 4 hit the 80 cap mid-fix-loop with ~30 turns lost to friction the
          // harness has since fixed — the cap is a runaway BACKSTOP, not a working budget, so it must sit
          // far above any legitimate build. The gates (todo/verify/read-loop) are what end a stuck session.
          maxTurns: 500,
          // ADR-036 SAFETY: the project dir is MODEL-WRITABLE, but hook commands spawn on the HOST — never
          // load a hooks.json the builder itself could have written (sandbox escape at the next open()).
          loadProjectHooks: false,
          // ADR-051: a builder project is "done" when it compiles — declare it, so the verify gate holds the
          // model to `npm run build` by name instead of accepting "I created all the files" on faith.
          checkCommand: 'npm run build',
          // ADR-055: base skills are SERVER-owned (immutable — outside the project and the Read jail);
          // user skills in the project shadow base by name and are theirs to edit.
          skillDirs: skillDirsFor(dir),
          // ADR-056: named agents — base personas server-owned; user personas in the project shadow by name.
          // ADR-056 rung 2 activation is NOT wired here: the base planner.md declares `proactive: true`
          // in its own frontmatter (the idiom: policy travels with the capability, never a session flag).
          agentDirs: agentDirsFor(dir),
          // ADR-056 rung 5: PLAN.md is pinned into the builder's system prompt, re-read each turn — the
          // contract is ALWAYS in context (measured: the builder read it 0 times when only on disk), and
          // survives compaction across iterate rounds (the whole reason a durable plan exists).
          contextFiles: [join(dir, 'PLAN.md')],
          // Server-owned EXTRA tools, each self-gating:
          // - Browser (ADR-060): the agent LOOKS at the app — needs model `vision` + a Docker sandbox.
          // - ApplyPack (ADR-066): graduate the prototype to a backend — offered only while the template
          //   has an UN-applied pack (createPackTool returns undefined otherwise, e.g. after graduation).
          //   templateId is 'react' — every Cascade project uses the one React template (cf.
          //   ensureVisualEditConfig).
          // - ImageSearch (ADR-071): real stock photos for the app — server-side because it's coupled to the
          //   preview CSP img-src allowlist. Always offered (no gating; it degrades to webPhoto/ArtImage).
          extraTools: [
            // Browser rides on BOTH runtimes now (browserHostFor adapts host-mode previewPort/startDev),
            // and vision no longer gates the TOOL — only op:"screenshot" (2026-08-10: a text-only local
            // quant had no runtime smoke channel at all; snapshot/audit/probe are text and stay).
            ...((): import('@cascade/core').Tool[] => {
              const host = browserHostFor(sandbox as unknown as import('./projectRuntime.js').ProjectRuntime | undefined)
              return host ? [createBrowserTool({ sandbox: host, vision: this.visionOk })] : []
            })(),
            createImageSearchTool(),
            ...([
              createPackTool({ projectDir: dir, templateId: 'react' }),
              // P1: the residue audit — self-gates to undefined when the template ships no contract.
              createTemplateAuditTool({ projectDir: dir, templateId: 'react' }),
              // P5: mechanical restyle (preset/skin swap) — self-gates when the project has no themes.
              // The complement of frozenPaths above: blocks can't be hand-edited, only swapped whole.
              createRestyleTool({ projectDir: dir, templateId: 'react' }),
            ].filter(Boolean) as import('@cascade/core').Tool[]),
          ],
        }))
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
        createPlannerSession(d, {
          dir,
          // ADR-067: the ACTIVE selection, NOT `opts` (the env seed). Measured 2026-07-22: with the picker on
          // a local Ollama model, the plan stage still ran its whole pass on CASCADE_MODEL — Ollama's request
          // log shows zero calls for the 56s the planner spent making 10 model calls to the hosted default.
          // Silent, billed, and invisible except in a per-message label.
          provider: this.makeProvider({ provider: this.active.provider, model: this.active.model, baseUrl: this.active.baseUrl, apiKey: this.active.apiKey, api: this.active.api }),
          model: this.active.model,
          // The window matters as much as the model: unset, a local backend silently front-truncates the
          // prompt (ADR-038) — so the planner must size against the same window the builder uses.
          contextWindow: this.active.contextWindow,
          // UNSET means the window-ratio default ('auto' → max(window/8, 2048) capped at 16,384 — core's
          // recommendedMaxOutputTokens), NOT the flat 16,384 the providers fall back to. On small windows
          // the flat cap let a weak model's thinking eat 40% of the context (measured: 16,384 of 40,960),
          // dragging the wire wall and the compaction trigger down with it. An explicit value still wins.
          maxOutputTokens: this.active.maxOutputTokens ?? ('auto' as const),
          skillDirs: skillDirsFor(dir),
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
    if (templateId) {
      applyTemplate(templateId, dir) // copy the scaffold (Vite+React+TS+Tailwind, etc.)
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
  get currentModel(): string {
    return this.active.model
  }

  /** ADR-067: switch the active provider/model at RUNTIME (no server restart). Invalidates every cached
   *  session so the next open() rebuilds with the new provider; conversation history lives in chatStore and
   *  reloads on re-open. The API key is resolved from the ENVIRONMENT for the built-in providers, OR passed
   *  explicitly (ADR-076: a custom endpoint's key, held server-side in the registry, never by the client).
   *  On a provider change, the old baseUrl/contextWindow/apiKey are dropped (provider-specific) unless supplied. */
  async setModelConfig(cfg: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; api?: 'openai' | 'ollama'; contextWindow?: number; maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number; repeatPenalty?: number; presencePenalty?: number }): Promise<void> {
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
