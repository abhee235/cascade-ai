// agent/agentLoop.ts — THE agentic loop.
//
// "Agentic" = a while-loop around a stateless model:
//   stream the model → collect any tool_use blocks → if NONE, that's the final answer (terminal);
//   else run the tools, append their tool_results, and loop so the next call sees them.
// Tool use is detected by PRESENCE of tool_use blocks, not by stop_reason (stop_reason is
// unreliable). The recurse is the agent.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityEvent, ContentBlock, Message } from '../protocol'
import type { ModelProvider, ToolSchema } from '../llm/provider'
import type { ToolContext } from '../tools/Tool'
import type { PermissionController } from '../permissions/gate'
import { NoopTracer, type Tracer } from '../observability/tracer'
import { createRegistry, registryOf, type ToolRegistry } from '../tools/toolRegistry'
import { scopeToolsByGrants } from '../tools/toolGrants'
import { buildSystemPrompt } from './systemPrompt'
import { compactIfNeeded, estimateTokens, measureWireOverhead, type CompactDeps } from '../context/compactor'
import { streamWithRecovery, type RecoveryOptions } from '../llm/resilience'
import type { ToolUse } from '../tools/runTool'
import { scheduleTools } from '../tools/scheduler'
import { withoutEscalationFields } from '../sandbox/escalation'
import { buildTodoReminder, shouldRemindTodos, type TodoReminderConfig } from './todoReminder'
import { buildRunBeforeDoneNudge, buildStalledAuditNudge, buildStalledVerifyNudge, buildVerifyNudge, foldRunBeforeDone, foldVerifyState, isFilteredVerify, isVerifyCommand, STALLED_AUDIT_TURNS, STALLED_VERIFY_TURNS } from './verifyGate'
import { buildDelegateNudgeText, foldReadPressure, READ_PRESSURE_FRACTION, sawSubagent } from './delegateNudge'
import { buildReadLoopNudge, foldReadLoop } from './readLoopGate'
import { buildReEditNudge, foldReEdit, reEditCount } from './reEditGate'
import { recallForTurn, recentFocusText } from './dynamicRecall'
import { editedTsFiles, postEditDiagnostics } from './postEditCheck'
import { agentChildInstructions } from './agentDefs'
import { runHooks } from '../hooks/hookRunner'

export interface LoopDeps {
  provider: ModelProvider
  model: string
  cwd: string
  signal: AbortSignal
  maxTurns?: number
  permission?: PermissionController // Phase 7: gates tool calls; how 'ask' awaits the user
  tracer?: Tracer // ADR-023: forensic JSONL trace
  registry?: ToolRegistry // Phase 9: builtins + ready MCP tools; defaults to builtins-only
  archival?: import('../memory/archival').ArchivalMemory // Phase 10: semantic memory the tools can use
  recalled?: string // Phase 10: archival memories auto-retrieved for this turn (proactive retrieval)
  extraInstructions?: string // Phase 15: generic extra system-prompt context (e.g. a template's AI rules)
  projectContext?: string // ADR-046: gathered project facts (dir tree + git status), main-agent only
  compact?: CompactDeps // Phase 11: compact the history when it nears the window
  depth?: number // Phase 12: subagent nesting depth (0 = main agent)
  recovery?: Pick<RecoveryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep'> // Phase 12: tune/inject for tests
  sandbox?: import('../sandbox/sandbox').Sandbox // Phase 13.3: redirect command tools here (injected by the server)
  /** ADR-070 step 1: the session's standing file-effect policy. Absent + a sandbox present ⇒ derived as
   *  workspace-write at the sandbox root (the truthful description of the Docker builder today); absent +
   *  no sandbox ⇒ no policy line (the extension's prompts stay byte-identical). */
  sandboxPolicy?: import('../sandbox/policy').SandboxPolicy
  /** ADR-033: how file paths are confined (jail vs prompt) and any additional allowed roots. */
  pathScope?: import('../tools/projectPath').PathScope
  readFileState?: import('../tools/fileState').FileStateCache // ADR-032: read-before-edit freshness cache (session-scoped)
  todoStore?: import('../tools/todoStore').TodoStore // ADR-034: authoritative todo checklist (drives the reminder)
  todoReminder?: TodoReminderConfig // ADR-034: tune/inject the reminder turn thresholds (default 6/6)
  ask?: import('../tools/Tool').AskController // ADR-043: AskUserQuestion round-trip channel (main agent only)
  /** ADR-049: refuse a terminal answer when files were edited but nothing verified them (one nudge turn,
   *  then accept). Default ON — it only ever fires when unverified edits exist. Set false to opt out. */
  verifyGate?: boolean
  /** ADR-051: the check that defines "done" for this session (eval/builder pass it; the session may resolve
   *  one from package.json). With a check known, the nudge NAMES the command and the gate allows two strikes;
   *  a DECLARED check also holds no-edit terminals to it. Absent ⇒ ADR-049 behavior exactly. */
  check?: import('./verifyGate').CheckCommand
  /** ADR-050 rung 2: when bulk reads have eaten a large share of the window and no delegation happened,
   *  remind the model ONCE to send explore subagents instead. Default ON; needs a known window (compact
   *  deps) and the Subagent tool in the registry, so children/chat-only sessions never see it. */
  delegateNudge?: boolean
  /** ADR-036: project hook config (.cascade/hooks.json), loaded once by the session. */
  hooks?: import('../hooks/hookRunner').HooksConfig
  /** ADR-038 enforcement: CONFIDENT allocated limits (user-pinned or /api/show-detected — never the static-map
   *  guess). Sent on every model request so the wire window equals the planned window. */
  modelLimits?: { contextWindow?: number; maxOutputTokens?: number }
  /** ADR-067: per-model sampling — passed on every stream request (each provider applies what it supports). */
  sampling?: { temperature?: number; topP?: number; topK?: number; repeatPenalty?: number; presencePenalty?: number; thinking?: import('../llm/provider').ThinkingLevel }
  /** ADR-037: window tier sizing the system prompt + tool descriptions. Defaults to the compaction plan's tier
   *  (one source of truth); set explicitly for loops without compaction (e.g. subagents inherit the parent's). */
  tier?: import('../llm/contextWindows').WindowTier
  /** ADR-055: pre-rendered skills index for the system prompt (bodies load via the Skill tool). */
  skillsSection?: string
  contextFiles?: string[] // ADR-056 rung 5: files pinned into the system prompt, re-read fresh each turn
  /** ADR-059: push type errors to the model after each mutating turn (diagnostics PUSHED, as an IDE does).
   *  Default: ON when a sandbox exists (builder/eval — the check runs inside it), OFF on the bare host
   *  (extension chat: the IDE already shows diagnostics, and a monorepo LanguageService build is costly). */
  postEditCheck?: boolean
  /** ADR-055: the loaded skills — needed by named agents to PRELOAD skill bodies into child prompts. */
  skills?: import('../skills/skills').Skill[]
  /** ADR-056: named agent definitions the Subagent tool can spawn by name. */
  agentDefs?: import('./agentDefs').AgentDef[]
}

const MAX_SUBAGENT_DEPTH = 2
const READONLY_SUBAGENT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'MemorySearch', 'Skill']) // skills are read-only knowledge — children benefit too

function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')
}

// Append a reminder (<system-reminder> text) as a block on the trailing user message (ADR-034/049/050 share this). The leading blank line separates it
// from any preceding text (e.g. the initial user input); when the trailing message is a tool_results message,
// the reminder is its only text block, which the OpenAI converter emits as a clean user turn after the tools.
function appendReminder(messages: Message[], reminder: string): void {
  const last = messages[messages.length - 1]
  const text = `\n\n${reminder}`
  if (!last || last.role !== 'user') {
    messages.push({ role: 'user', content: text })
    return
  }
  const blocks: ContentBlock[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content]
  blocks.push({ type: 'text', text })
  messages[messages.length - 1] = { ...last, content: blocks }
}

// ── Streaming DEGENERATION guard (measured 2026-07-26: 186 seconds of '@@@@…' thinking before the user
// killed the turn). A degenerate attractor emits one short token forever; the always-on max_tokens backstop
// is MINUTES away at local decode speed, and nothing else watches the stream. Detection: a 400-char window
// of generated output containing ≤4 distinct characters is garbage — legit output (code, prose, tables)
// always exceeds that. Cut the stream immediately, discard the garbage, retry the turn (bounded).
const DEGEN_WINDOW = 400
const DEGEN_RUN = 200
export function isDegenerateTail(out: string): boolean {
  if (out.length < DEGEN_WINDOW) return false
  const w = out.slice(-DEGEN_WINDOW)
  // Two independent signatures, tightened after auditing 123 real turns (zero runs ≥40 in legit output —
  // but ≤4-distinct alone could false-positive on ASCII game-board art, which the game-dev skill invites):
  //  (a) the window is down to ≤2 distinct characters (pure padding/echo collapse), or
  //  (b) ONE character repeats ≥200 consecutively (the '@@@@…' incident: thousands-long single run).
  if (new Set(w).size <= 2) return true
  let run = 1
  for (let i = 1; i < w.length; i++) {
    run = w[i] === w[i - 1] ? run + 1 : 1
    if (run >= DEGEN_RUN) return true
  }
  return false
}

// ── SCREENSHOT EVICTION. Honest ledger (introspection 2026-07-26): the original "vision poison" hypothesis
// was FALSIFIED by the joined data — turns carrying images had a LOWER median prefill (1,962ms vs 2,344ms;
// prefix caching means images encode once), and the 127/137s outliers carried zero images. The real, modest
// cost is re-encoding on cache-MISS turns (~4s per image, measured t45 vs t26). So this evicts narrowly:
// only TOOL-RESULT images (Browser screenshots — their judgment is already extracted into the result text),
// keeping the latest hot. USER-uploaded images are NEVER touched: a pasted design reference must survive
// the whole session (evicting it would break replicate-this-design flows for a few seconds of miss savings).
export function evictStaleImages(messages: Message[]): void {
  const isToolResultMsg = (m: Message | undefined): boolean =>
    !!m && typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')
  let latest = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content
    if (isToolResultMsg(messages[i]) && typeof c !== 'string' && c?.some((b) => b.type === 'image')) {
      latest = i
      break
    }
  }
  for (let i = 0; i < messages.length; i++) {
    if (i === latest) continue
    if (!isToolResultMsg(messages[i])) continue // user-uploaded images are untouchable
    const c = messages[i]!.content
    if (typeof c === 'string' || !c.some((b) => b.type === 'image')) continue
    messages[i] = {
      ...messages[i]!,
      content: c.map((b): ContentBlock => (b.type === 'image' ? { type: 'text', text: '[screenshot evicted — viewed in an earlier turn; capture a fresh one if needed]' } : b)),
    }
  }
}

export async function* runAgentLoop(messages: Message[], deps: LoopDeps): AsyncIterable<ActivityEvent> {
  const tracer = deps.tracer ?? NoopTracer
  const registry = deps.registry ?? createRegistry()
  // Share ONE registry instance for the turn: the loop advertises with it, and the scheduler/runTool look
  // up with it — so what the model is offered and what we execute always agree.
  const depth = deps.depth ?? 0
  // ADR-037: one window tier for the whole loop — sizes the system prompt AND the tool descriptions. Explicit
  // deps.tier (subagents inherit the parent's) → the compaction plan's tier → 'full'.
  const tier = deps.tier ?? deps.compact?.plan.tier ?? 'full'
  // Where COMMANDS execute. Bash tailors its shell-syntax guidance to this (measured: `mkdir -p` failed on
  // cmd.exe turn 1). A sandbox DECLARES its shell and defaults to POSIX — true for a container whatever the
  // host is, but NOT for a host-process sandbox on Windows, which runs cmd.exe and must say so.
  const hostPlatform: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix'
  const execPlatform: 'win32' | 'posix' = deps.sandbox ? (deps.sandbox.shell ?? 'posix') : hostPlatform
  // ADR-070 step 1: the standing policy for the prompt line (and, step 2+, for enforcement). Derived ONCE —
  // stable per session, so the rendered line never breaks the KV-cache prefix.
  const sandboxPolicy = deps.sandboxPolicy ?? (deps.sandbox ? { mode: 'workspace-write' as const, workspaceRoot: deps.sandbox.root } : undefined)
  // ADR-052: window-derived Read cap — one bite must never exceed the plate. Budget: a single read may span
  // ~25% of the effective window; at ~4 chars/token that is numerically effectiveWindow in CHARS. 8k window →
  // ~6k chars (~1.5k tok); 32k → ~24k chars; big windows hit the 50k ceiling → unchanged (no-overfitting rule).
  const readCapChars = deps.compact ? Math.min(50_000, Math.max(6_000, deps.compact.plan.effectiveWindow)) : undefined
  const ctx: ToolContext = { cwd: deps.cwd, abortSignal: deps.signal, permission: deps.permission, tracer, registry, archival: deps.archival, depth, sandbox: deps.sandbox, sandboxPolicy, pathScope: deps.pathScope, readFileState: deps.readFileState, todoStore: deps.todoStore, ask: deps.ask, hooks: deps.hooks, readCapChars }
  // ADR-082: what we ADVERTISE this turn. The sandbox-escalation fields are hidden until a real denial has
  // happened (ctx.sandboxDenialSeen, set by the scheduler) — an optional field the model can see is a field
  // it fills, measured at 35/35 no-op asks in one build. Recomputed per turn, so the lever appears the turn
  // AFTER the first denial and the overhead estimate below can never drift from what actually goes on the wire.
  const advertise = (): ToolSchema[] => {
    const schemas = registry.schemas(tier, execPlatform)
    return ctx.sandboxDenialSeen ? schemas : withoutEscalationFields(schemas)
  }
  // Subagent delegation (ADR-017): inject a spawn closure (avoids an import cycle). Absent at the depth cap.
  // The child runs a NESTED runAgentLoop with its OWN messages + a filtered tool set (never Subagent → no
  // recursion; read-only subset for `explore`). Only its final text returns — its steps stay in its context.
  if (depth < MAX_SUBAGENT_DEPTH) {
    ctx.spawnSubagent = async ({ prompt, readOnly, agent }) => {
      // ADR-056: a NAMED agent resolves to a file-defined persona — its body becomes the child's system
      // prompt (REPLACING parent extraInstructions: personas don't inherit builder-behavior), its tool
      // allowlist filters the child registry, its `skills:` are preloaded into the prompt.
      let def: import('./agentDefs').AgentDef | undefined
      if (agent) {
        def = (deps.agentDefs ?? []).find((d) => d.name.toLowerCase() === agent.trim().toLowerCase())
        if (!def) {
          const names = (deps.agentDefs ?? []).map((d) => d.name).join(', ') || '(none defined)'
          return `No agent named "${agent}". Available agents: ${names}. Call Subagent again with one of these exact names, or omit \`agent\` for a plain subagent.`
        }
      }
      // A named agent's `tools:` is an arg-scoped grant list (`Write(PLAN.md)` restricts, not just filters);
      // an anonymous explore subagent falls back to the read-only subset. Subagent is always stripped (no
      // recursion via this path).
      const childRegistry = registryOf(() => {
        const base = registry.list().filter((t) => t.name !== 'Subagent')
        if (def?.tools) return scopeToolsByGrants(base, def.tools)
        return base.filter((t) => !readOnly || READONLY_SUBAGENT_TOOLS.has(t.name))
      })
      let finalText = ''
      for await (const ev of runAgentLoop([{ role: 'user', content: prompt }], {
        provider: deps.provider,
        model: deps.model,
        cwd: deps.cwd,
        signal: deps.signal,
        registry: childRegistry,
        tracer,
        permission: deps.permission,
        sandbox: deps.sandbox, // subagent's commands run in the same sandbox
        sandboxPolicy, // ADR-070: and under the same standing file policy (the parent's derived one)
        pathScope: deps.pathScope, // and under the same path policy
        readFileState: deps.readFileState, // share freshness cache: a file the parent read is editable by the child
        todoStore: deps.todoStore, // shared store, keyed by depth → the child's checklist is scoped separately
        todoReminder: deps.todoReminder,
        tier, // child loops have no compact deps — inherit the parent's window tier (same model, same window)
        maxTurns: def?.maxTurns ?? 8,
        depth: depth + 1,
        extraInstructions: def ? agentChildInstructions(def, deps.skills ?? []) : undefined,
      })) {
        if (ev.type === 'message') {
          const t = messageText(ev.message)
          if (t) finalText = t // last assistant message wins (the subagent's conclusion)
        }
      }
      return finalText || '(subagent produced no output)'
    }
  }
  const maxTurns = deps.maxTurns ?? 10
  let turn = 0
  // ADR-049 verification gate: `editedSinceVerify` = a file-mutating tool succeeded and no test command has
  // run since. At the terminal branch we nudge, then (after the strike budget) accept unconditionally.
  // ADR-051: with a known check the budget is 2 strikes (weak models ignore single nudges — measured) and a
  // DECLARED check also holds no-edit terminals to it (`verifiedEver`); without one, exact ADR-049 behavior.
  let editedSinceVerify = false
  let verifyNudges = 0
  let verifiedEver = false
  // Design-overhaul P1 (generalized): pending run-before-done state for every registry tool declaring
  // Tool.mustRunBeforeDone (see verifyGate.foldRunBeforeDone). One nudge per submit, verify-gate budget.
  let pendingBeforeDone = new Set<string>()
  let beforeDoneNudged = false
  // Stop hook (ADR-036 extension, the Stop event): a project/frontend hook may block ONE terminal per
  // submit with a reason — the user's own deterministic done-policy, no core flag required.
  let stopHookFired = false
  // Two strikes ONLY for a DECLARED check (eval/builder said done-means-check-passes). A package.json-
  // resolved check improves the nudge TEXT but never the firing semantics — chat stays one-nudge (the
  // no-overfitting rule: resolved-from-repo must not make the gate pushier for everyday strong-model use).
  const verifyStrikes = deps.check?.declared ? 2 : 1
  // ADR-050 delegation nudge: cumulative bulk-read result tokens this submit; fires once when they cross
  // READ_PRESSURE_FRACTION of the window without any Subagent use. Window comes from the compaction plan.
  let readPressureTokens = 0
  let delegateNudged = false
  let subagentUsed = false
  let planNudged = false
  let plannerUsed = false
  // Degraded-backend guard: one recycle-and-retry per submit when a terminal response is entirely EMPTY.
  let emptyRetried = false
  // Thinking-only terminal guard (measured, dokar/qwen3.5-9B 2026-08-09): the final turn carried the whole
  // completion report INSIDE thinking (1.8k chars) and nothing in content — the visible chat ended in
  // silence while the report sat one channel over. One restate nudge; a second offense is accepted.
  let thinkingOnlyNudged = false
  // Todo gate: continue-nudge when the model goes terminal with open todo items. RE-ARMING (measured,
  // Simmer 128k submit 2): the old once-per-submit budget was spent on a turn-0 conversational answer;
  // 7 turns later the model dropped the ball mid-fix with a THINKING-ONLY terminal ("Let me fix data.ts
  // and then build the remaining views" — then silence) and the spent gate let it end. A silent stop after
  // successful tool work is a NEW event: any successful call re-arms the gate, capped per submit.
  let todoGateFirings = 0
  let workedSinceTodoGate = false
  const TODO_GATE_MAX_FIRINGS = 3
  // MAX-TOKENS continuation (2026-07-23): a no-tool-call turn cut off at the output ceiling is the model
  // spiralling in thinking without acting (measured: a 31-min, ~84k-token thinking runaway). It is NOT a
  // finished answer — continue the turn with a sharp "act now" nudge, bounded so it can't loop forever.
  // The backstop cap is in ollama.ts.
  let maxTokensNudges = 0
  const MAX_TOKENS_STRIKES = 3
  // The last FAILED tool call of the previous batch (name + error head) — when the model goes terminal
  // right after a failed call, the gate names it so the retry is concrete, not aspirational.
  let lastToolFailure: string | undefined
  // ADR-059: the missing-node_modules directive fires once per submit (see the post-edit check below).
  let depsNudged = false
  // ADR-058 read-loop breaker: per-file successful-read counters, reset by a successful Write/Edit of the
  // file. Only meaningful in loops that CAN mutate — an explore subagent's registry has no Write/Edit, so
  // repeated reads there are its job, not a loop.
  const readLoopCounts = new Map<string, number>()
  // ADR-072 re-edit breaker: per-file successful-edit counters — sustained churn on one file → Grep/Lsp nudge.
  const reEditCounts = new Map<string, number>()
  // ADR-074 dynamic recall: facts already surfaced at the tail this session (dedup) + the last query embedded
  // (throttle — an unchanged focus mid-tool-loop must not re-embed for an identical result).
  const surfacedMemories = new Set<string>()
  let lastRecallQuery: string | undefined
  const canMutate = registry.list().some((t) => t.name === 'Write' || t.name === 'Edit' || t.name === 'MultiEdit')
  // ADR-058 mid-flight check nudge: consecutive turns spent in unverified-edit state; one reminder per submit.
  let stalledVerifyTurns = 0
  let stalledVerifyNudged = false
  // …and the same for the declared before-done tool: a weak model never STOPS, so it never reaches the
  // terminal gate that would have told it the entry point is still the starter scaffold.
  let stalledAuditTurns = 0
  let stalledAuditNudged = false
  // REPEAT-NARRATION BREAKER (measured 2026-07-25): a session spent turns 100-103 re-emitting the SAME opening
  // — "The snapshot is completely empty … Let me systematically debug:" — each time calling one read. The
  // read-loop and re-edit breakers both missed it: the files differed, so no single counter crossed. The tell
  // is the PROSE repeating, which means the model is re-deciding instead of progressing. Same detect→inject
  // idiom, keyed on a normalized prefix of the turn's text.
  let lastNarration = ''
  let narrationRepeats = 0
  const NARRATION_REPEAT_LIMIT = 2 // 2 repeats = 3 identical openings; below that a restated plan is normal
  // IDENTICAL-CALL BREAKER. The signal the loop-detection literature calls definitional ("three identical
  // tool calls in one task IS a loop") and the one Cascade lacked — our read-loop/re-edit breakers are
  // per-FILE, so a model alternating across different files (or re-running the same non-file call) slipped
  // through. Hashing name+args with a threshold of 5 is common; we use 3 because we NUDGE rather than halt,
  // so firing early is cheap. Crucially the counters RESET on a mutation: `npm run build` repeated after each
  // edit is PRODUCTIVE (same args, different result) and must never trip — the same reset rule the read-loop
  // breaker already uses.
  const repeatCallCounts = new Map<string, number>()
  const REPEAT_CALL_LIMIT = 3
  const MUTATING = new Set(['Write', 'Edit', 'MultiEdit'])
  // PER-SUBMIT TOOL-CALL CAP (100 calls). Measured 2026-07-25: one submit ran
  // 114 turns thrashing a bug it never solved. maxTurns (500) is a runaway backstop, not a work budget — this
  // is the "you are not converging, report what's blocking" checkpoint. Nudge once, never a hard stop.
  let toolCallsThisSubmit = 0
  let toolCapNudged = false
  const TOOL_CALL_CAP = 100
  const recycle = deps.provider.recover ? () => deps.provider.recover!(deps.model) : undefined
  // Wire-overhead calibration (ADR-052 companion): real prompt tokens minus our message estimate, EMA'd.
  // Undefined until the backend reports usage once; the static chars/4 overhead estimate is the floor.
  let wireOverhead: number | undefined
  // ADR-078: live per-turn context growth (real inputTokens deltas) — the constrained compaction trigger
  // sizes its "N turns of headroom" from the p75 of these, so a fast-growing session compacts earlier.
  let lastInputTokens: number | undefined
  let degenCuts = 0 // degeneration-guard retries this submit (bounded — a persistently degenerate backend must not loop forever)
  const growthSamples: number[] = []
  const turnGrowthP75 = (): number | undefined => {
    if (growthSamples.length < 5) return undefined // fallback constant applies until we have signal
    const s = [...growthSamples].sort((a, b) => a - b)
    return s[Math.floor(s.length * 0.75)]
  }

  while (true) {
    let text = ''
    let thinking = ''
    let usage: import('../llm/provider').TokenUsage | undefined // E1/ADR-040: backend token counts for this call
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | undefined // why the generation ended (max_tokens ⇒ cut off, not finished)
    const toolUses: ToolUse[] = []

    // The WIRE prompt carries more than `messages`: system prompt + tool schemas + chat template. Measure it
    // so compaction thresholds reflect what actually travels — in an 8k window the overhead is ~half the
    // budget, and ignoring it meant Ollama front-truncated the prompt before the compactor ever triggered
    // (measured: inputTokens 8191 of 8192, ONE token of output room). The static chars/4 estimate is the
    // FLOOR; once the backend has reported a real prompt size, the MEASURED overhead (real − estimate,
    // which also captures our estimate's own error) takes over — self-correcting at the margin.
    const systemNow = buildSystemPrompt({ cwd: deps.cwd, sandboxRoot: deps.sandbox?.root, tier, subagent: depth > 0, recalled: deps.recalled, extraInstructions: deps.extraInstructions, projectContext: deps.projectContext, skillsSection: deps.skillsSection, contextFiles: deps.contextFiles, sandboxPolicy })
    const staticOverhead = Math.ceil((systemNow.length + JSON.stringify(advertise()).length) / 4) + 256
    const overheadTokens = Math.max(staticOverhead, wireOverhead ?? 0)

    // Compaction (ADR-012): BEFORE each model call, if history nears the window, mask old tool output and/or
    // summarize the older half. We splice in place so the session's history reference stays valid; the raw
    // transcript + JSONL trace are untouched (you'll see the next model_request shrink).
    evictStaleImages(messages) // vision tokens are prefill poison — only the newest image stays hot
    if (deps.compact) {
      const tokensBefore = estimateTokens(messages)
      const { messages: compacted, kind } = await compactIfNeeded(messages, { ...deps.compact, overheadTokens, turnGrowth: turnGrowthP75() })
      if (kind !== 'none') {
        messages.splice(0, messages.length, ...compacted)
        // E1/ADR-040: record which layer fired and what it reclaimed — the eval analyzer counts these to
        // diagnose context_thrash (≥3 compactions per run ⇒ thresholds/window are the knob to tweak).
        tracer.event({ t: 'compaction', kind, tokensBefore, tokensAfter: estimateTokens(messages), forced: false })
        yield { type: 'compacted', kind }
      }
    }

    // ADR-034: if the model has drifted from its task checklist (idle on TodoWrite for several turns), re-inject
    // the current list as a <system-reminder> so it re-grounds. Appended to the trailing user message (always a
    // user message here — initial input or tool_results) so the converter emits it as a user turn AFTER any
    // tool_results. NOT yielded as an activity event ⇒ it reaches the model but never the UI. Done after
    // compaction so the reminder isn't immediately summarized away (and reflects the post-compaction state).
    if (deps.todoStore) {
      const items = deps.todoStore.get(depth)
      if (shouldRemindTodos(messages, items, deps.todoReminder)) appendReminder(messages, buildTodoReminder(items))
    }

    // ADR-074 dynamic recall: re-search archival on the CURRENT focus and surface any strong fact learned earlier
    // this build that the model no longer has in raw context (compacted away). Appended at the TAIL so the KV
    // cache prefix is untouched; deduped + throttled so it never spams or re-embeds an unchanged focus. Best-effort
    // — a retrieval failure must never derail the turn. Placed AFTER compaction so it reflects the trimmed state
    // and the injection survives (isn't summarised away on this turn).
    if (deps.archival) {
      try {
        const focus = recentFocusText(messages)
        const reminder = await recallForTurn({ archival: deps.archival, query: focus, surfaced: surfacedMemories, lastQuery: lastRecallQuery })
        lastRecallQuery = focus || lastRecallQuery
        if (reminder) {
          appendReminder(messages, reminder)
          tracer.event({ t: 'recall', turn, count: (reminder.match(/\n- /g) ?? []).length })
        }
      } catch {
        /* recall is advisory; never fail a turn over it */
      }
    }

    yield { type: 'status', text: 'Thinking…' }
    // Explicit STEP-START signal (the dead-air contract): prefill is about to begin — the phase where a
    // local model re-reads the whole prompt and streams NOTHING for many seconds. UIs show "reading
    // input…" from here until the first delta; ONLY turnDone ever means "finished".
    yield { type: 'step', n: turn + 1 }
    const sentEstimate = estimateTokens(messages) // for wire-overhead calibration once real usage arrives
    // FORENSICS: record the FULL request we're about to send — the #1 thing you need when an answer
    // is wrong ("did the model even see the tool_result / the right system prompt?"). — ADR-023.
    tracer.event({ t: 'model_request', turn, provider: deps.provider.id, model: deps.model, contextWindow: deps.modelLimits?.contextWindow, system: systemNow, tools: registry.list().map((t) => t.name), messages })
    // Wrap the stream in recovery (ADR-016): transient failures retry with backoff; context overflow triggers
    // a (reactive) compaction then retries; abort/fatal surface. `make` re-reads `messages` each attempt, so
    // an overflow-compaction is reflected on the retry. System is rebuilt too (memory may have changed).
    const makeStream = () =>
      deps.provider.stream({ messages, model: deps.model, ...deps.modelLimits, ...deps.sampling, system: buildSystemPrompt({ cwd: deps.cwd, sandboxRoot: deps.sandbox?.root, tier, subagent: depth > 0, recalled: deps.recalled, extraInstructions: deps.extraInstructions, projectContext: deps.projectContext, skillsSection: deps.skillsSection, contextFiles: deps.contextFiles, sandboxPolicy }), tools: advertise() }, deps.signal)
    for await (const ev of streamWithRecovery(makeStream, {
      ...deps.recovery,
      signal: deps.signal,
      recover: recycle, // WATCHDOG: recycle a degraded backend
      // ADR-061: lets the watchdog tell "busy with a huge cold prefill" from "dead" before the first token —
      // without it, every big-context first turn was killed at stallTimeoutMs and recycled into a churn loop.
      alive: deps.provider.alive ? () => deps.provider.alive!() : undefined,
      onOverflow: deps.compact
        ? async () => {
            // Reactive overflow: force compaction regardless of the threshold (ADR-039 `force`) — the model just
            // reported the prompt is too large, so waiting for the `auto` gate would just loop.
            const tokensBefore = estimateTokens(messages)
            const { messages: c, kind } = await compactIfNeeded(messages, { ...deps.compact!, overheadTokens, turnGrowth: turnGrowthP75() }, { force: true })
            if (kind !== 'none') {
              messages.splice(0, messages.length, ...c)
              tracer.event({ t: 'compaction', kind, tokensBefore, tokensAfter: estimateTokens(messages), forced: true })
            }
          }
        : undefined,
      onRetry: (info) => tracer.event({ t: 'error', message: `recover(${info.reason}) attempt ${info.attempt}, wait ${Math.round(info.delayMs)}ms` }),
    })) {
      if (ev.type === 'retry') {
        // A failed attempt is being retried: DISCARD any partial output from it (so we don't double-count
        // text), and surface a persistent recovery CARD so the user sees we're reconnecting, not dead.
        text = ''
        thinking = ''
        usage = undefined
        toolUses.length = 0
        yield { type: 'recovering', attempt: ev.attempt, reason: ev.reason, delayMs: ev.delayMs }
      } else if (ev.type === 'slow_prefill') {
        // ADR-061: the backend is alive and still prefilling a big prompt — tell the user the truth
        // instead of looking dead (and record it: slow turns must be attributable in the trace).
        tracer.event({ t: 'slow_prefill', turn, waitedMs: ev.waitedMs })
        yield { type: 'status', text: `Large prompt — the model is still reading it (${Math.round(ev.waitedMs / 1000)}s)…` }
      } else if (ev.type === 'thinking_delta') {
        thinking += ev.thinking
        if (isDegenerateTail(thinking)) break // degeneration guard: stop consuming — cleanup aborts the fetch
        yield { type: 'thinking_delta', thinking: ev.thinking }
      } else if (ev.type === 'text_delta') {
        text += ev.text
        if (isDegenerateTail(text)) break
        yield { type: 'text_delta', text: ev.text }
      } else if (ev.type === 'tool_call_start') {
        // Forward the args-generation boundary so the UI can settle the thinking card on a REAL event.
        yield { type: 'toolPending', name: ev.name }
      } else if (ev.type === 'tool_use') {
        toolUses.push({ id: ev.id, name: ev.name, input: ev.input, repaired: ev.repaired })
      } else if (ev.type === 'done') {
        if (ev.usage) usage = ev.usage // backend-reported prompt/output token counts (undefined when not reported)
        stopReason = ev.stopReason // 'max_tokens' ⇒ the generation was CUT OFF at the output ceiling
      }
    }

    // Degeneration guard tripped: the tail of the generation is single-token garbage. Discard the whole
    // attempt (garbage must never enter history — it would poison every later prefill) and re-ask the same
    // turn, at most twice per submit; past that, surface what happened instead of looping.
    if ((isDegenerateTail(thinking) || isDegenerateTail(text)) && toolUses.length === 0) {
      tracer.event({ t: 'degenerate_cut', turn, chars: thinking.length + text.length })
      if (degenCuts < 2) {
        degenCuts++
        yield { type: 'status', text: 'Model output degenerated (repeated-token loop) — cut it and retrying the step…' }
        text = ''
        thinking = ''
        continue // re-ask the SAME turn; nothing was recorded
      }
      yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'The model repeatedly degenerated into a token loop on this step. Try re-running, simplifying the request, or switching models.' }] } }
      break
    }

    // Calibrate: the backend just told us the REAL prompt size — remember what the wire adds beyond our
    // message estimate, so the next compaction decision compares against reality, not the chars/4 guess.
    if (usage?.inputTokens) {
      wireOverhead = measureWireOverhead(wireOverhead, usage.inputTokens, sentEstimate)
      // ADR-078: sample per-turn growth (positive, sane deltas only — a compaction shrink isn't "growth").
      if (lastInputTokens !== undefined) {
        const d = usage.inputTokens - lastInputTokens
        if (d > 0 && d < 30_000) growthSamples.push(d)
      }
      lastInputTokens = usage.inputTokens
    }

    tracer.event({ t: 'model_response', turn, text, thinking, toolUses, usage })

    // ADR-039: report OCCUPANCY to the UI — the prompt we just sent, against the window it must fit in.
    // Prefer the backend's own count; fall back to the same estimate the compactor gates on, so the meter
    // never goes blank on a backend that doesn't report usage. Main agent only: a subagent runs its own
    // window and its events are consumed internally, so surfacing them would just make the meter jump.
    if (deps.compact && depth === 0) {
      yield { type: 'context', used: usage?.inputTokens ?? sentEstimate + overheadTokens, window: deps.compact.plan.window, auto: deps.compact.plan.auto }
    }

    // Record the assistant turn in history: thinking, text, then tool_use blocks.
    const assistant: ContentBlock[] = []
    if (thinking) assistant.push({ type: 'thinking', thinking })
    if (text) assistant.push({ type: 'text', text })
    for (const tu of toolUses) assistant.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
    messages.push({ role: 'assistant', content: assistant })

    // Commit THIS turn's visible message (text + thinking, no tool_use blocks) so every step shows in
    // order: user → assistant text → tool card(s) → next assistant text. The UI commits each on `message`.
    const display: ContentBlock[] = []
    if (thinking) display.push({ type: 'thinking', thinking })
    if (text) display.push({ type: 'text', text })
    if (display.length) yield { type: 'message', message: { role: 'assistant', content: display } }

    // TERMINAL — no tool calls → done. Unless the verification gate objects (ADR-049/051): unverified
    // edits exist, or a DECLARED check was never run → inject a nudge turn and loop; after the strike
    // budget the answer is accepted unconditionally (the model may legitimately say "no tests exist here").
    if (toolUses.length === 0) {
      // MAX-TOKENS CUT-OFF (2026-07-23): the generation hit the output ceiling with no tool call — the model
      // was spiralling in thinking without acting, NOT answering. Treat it as an interrupted
      // turn: CONTINUE (sharp "act now" nudge), bounded by
      // strikes. Checked first — a cut-off turn has thinking, so the empty-response guard below never catches
      // it, and left unhandled the loop would read the truncated thought as a finished answer.
      if (stopReason === 'max_tokens' && maxTokensNudges < MAX_TOKENS_STRIKES && turn + 1 < maxTurns) {
        maxTokensNudges++
        tracer.event({ t: 'max_tokens_cut', turn })
        messages.push({
          role: 'user',
          content:
            '<system-reminder>Your previous turn was CUT OFF at the output limit — you produced a very long response without taking an action. Stop planning in your head: emit your single next step as ONE tool call (Write/Edit/Bash) right now. Do not reply to this note.</system-reminder>',
        })
        yield { type: 'status', text: 'Response hit the output limit — asking the agent to act…' }
        turn++
        continue
      }
      // DEGRADED-BACKEND retry (iterate-7 forensics): a crashed-then-reloaded local backend can return
      // SUCCESSFUL but EMPTY responses — no error is thrown, so the recovery machinery never fires, and
      // the session silently ends with nothing (the planner stage died exactly this way). An empty
      // terminal (no text, no thinking, no tools) is not an answer: recycle the backend once and re-ask.
      if (!text.trim() && !thinking.trim() && !emptyRetried && recycle && turn + 1 < maxTurns) {
        emptyRetried = true
        tracer.event({ t: 'degraded_retry', turn })
        try {
          await recycle()
        } catch {
          /* best-effort — the retry proceeds regardless */
        }
        yield { type: 'status', text: 'Empty response — recycling the model and retrying…' }
        turn++
        continue // re-ask with the SAME messages (nothing was appended this turn)
      }
      // TODO GATE (measured, Simmer walkthrough): the model ended with "Let me fix that and move on to
      // Create AddForm" — an INTENTION, then silence, with its own todo list still holding open items.
      // Prose-without-a-tool-call reads as terminal; the model's own checklist says otherwise. Refuse
      // ONCE, naming the open items — same detect→remind idiom as the verify gate.
      const openTodos = deps.todoStore?.get(depth).filter((td) => td.status !== 'completed') ?? []
      const todoGateArmed = todoGateFirings === 0 || workedSinceTodoGate // successful work since the last firing re-arms it
      if (deps.verifyGate !== false && openTodos.length > 0 && todoGateArmed && todoGateFirings < TODO_GATE_MAX_FIRINGS && turn + 1 < maxTurns) {
        todoGateFirings++
        workedSinceTodoGate = false
        tracer.event({ t: 'todo_gate', turn, open: openTodos.length })
        // A terminal right after a FAILED call is the model dropping the ball mid-recovery (measured:
        // garbled Edit args → validation error → thinking-only silence). Name the failure so the retry
        // is a concrete instruction, not a vibe.
        const failureNote = lastToolFailure
          ? ` Note: your last tool call FAILED — ${lastToolFailure}. Retry that call with corrected arguments as part of continuing.`
          : ''
        messages.push({
          role: 'user',
          content: `<system-reminder>Your own todo list still has ${openTodos.length} unfinished item(s): ${openTodos
            .slice(0, 5)
            .map((td) => `"${td.content}" (${td.status})`)
            .join(', ')}. You stopped mid-task.${failureNote} CONTINUE working through them now — or, if an item is genuinely already done or obsolete, update it with TodoWrite and then finish. Do not reply to this note.</system-reminder>`,
        })
        yield { type: 'status', text: 'Unfinished todos — asking the agent to continue…' }
        turn++
        continue
      }
      const unverified = editedSinceVerify || (deps.check?.declared === true && !verifiedEver)
      if (deps.verifyGate !== false && unverified && verifyNudges < verifyStrikes && turn + 1 < maxTurns) {
        verifyNudges++
        tracer.event({ t: 'verify_gate', turn })
        messages.push(buildVerifyNudge(deps.check, !editedSinceVerify))
        yield { type: 'status', text: 'Asking the agent to verify its changes…' }
        turn++
        continue
      }
      // RUN-BEFORE-DONE gate (design-overhaul P1, generalized): a terminal while any declared tool is
      // pending gets ONE nudge naming them — after the verify gate (build correctness outranks audits),
      // before the thinking-only salvage (real work first). No declarers ⇒ the set is always empty.
      if (deps.verifyGate !== false && pendingBeforeDone.size > 0 && !beforeDoneNudged && turn + 1 < maxTurns) {
        beforeDoneNudged = true
        tracer.event({ t: 'audit_gate', turn, tools: [...pendingBeforeDone] })
        messages.push(buildRunBeforeDoneNudge([...pendingBeforeDone]))
        yield { type: 'status', text: 'Asking the agent to run the pre-done checks…' }
        turn++
        continue
      }
      // STOP hook (ADR-036 extension, the Stop event): the USER's own terminal policy — a hook exiting 2
      // blocks this terminal once per submit, its stderr becoming the continue-nudge. Fail-open, budgeted.
      if (deps.hooks?.Stop?.length && !stopHookFired && turn + 1 < maxTurns) {
        stopHookFired = true // one evaluation per submit — a hook that allows is not re-asked either
        const stop = await runHooks({ event: 'Stop', config: deps.hooks, cwd: deps.cwd, toolName: '', toolInput: undefined }).catch(() => undefined)
        if (stop?.decision === 'deny') {
          tracer.event({ t: 'hook', event: 'Stop', id: '', tool: '', decision: 'deny', ms: 0 })
          messages.push({
            role: 'user',
            content: `<system-reminder>A project Stop hook blocked finishing: ${stop.reason ?? 'no reason given'}. Address it, then finish. Do not reply to this note.</system-reminder>`,
          })
          yield { type: 'status', text: 'A project hook asked the agent to continue…' }
          turn++
          continue
        }
      }
      // THINKING-ONLY terminal (measured, dokar/qwen3.5-9B): content empty, thinking full — the model
      // wrote its final report in the channel the user cannot see, and accepting it ends the session in
      // apparent silence. Checked LAST among the gates: real unfinished work (todos, verification) takes
      // priority, and this only fires when the turn would otherwise be accepted with nothing visible.
      if (!text.trim() && thinking.trim() && !thinkingOnlyNudged && turn + 1 < maxTurns) {
        thinkingOnlyNudged = true
        tracer.event({ t: 'thinking_only_terminal', turn })
        messages.push({
          role: 'user',
          content:
            '<system-reminder>Your turn ended with EMPTY visible output — everything you wrote went into private thinking, which the user cannot see. State your final answer now as plain text outside of thinking. Do not call tools and do not reply to this note — just give the user your answer/summary.</system-reminder>',
        })
        yield { type: 'status', text: 'Answer ended up in thinking — asking the agent to restate it…' }
        turn++
        continue
      }
      if (!display.length) yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }
      tracer.event({ t: 'turn_done', turns: turn })
      yield { type: 'turnDone', steps: turn }
      return
    }

    // Run the tools via the scheduler: read-only ones in parallel, writes serial (ADR-008). It yields
    // the toolStart/toolResult activity and returns the tool_result blocks in original order.
    const results = yield* scheduleTools(toolUses, ctx)
    // ADR-060: a tool that captured images for the MODEL (Browser screenshot) rides them on its result;
    // lift them into image blocks on the same user message — that's the only shape vision wires accept.
    const toolImages = results.flatMap((r) => (r.type === 'tool_result' && r.images ? r.images : []))
    messages.push({
      role: 'user',
      content: toolImages.length ? [...results, ...toolImages.map((url): ContentBlock => ({ type: 'image', url }))] : results,
    }) // tool_results become the next turn's input
    editedSinceVerify = foldVerifyState(editedSinceVerify, toolUses, results, deps.check?.command) // ADR-049 gate state
    pendingBeforeDone = foldRunBeforeDone(pendingBeforeDone, registry.list().filter((t) => t.mustRunBeforeDone).map((t) => t.name), toolUses, results)

    // Todo-gate re-arm state: ANY tool attempt (even a failed one) re-arms — measured (Simmer 128k submit 3):
    // the gate fired, the model complied with a TodoWrite whose args were corrupted (call FAILED), then went
    // silent again — and success-only re-arming let that count as the end. A failed attempt is compliance,
    // not stonewalling; the TODO_GATE_MAX_FIRINGS cap keeps re-arming bounded. Also remember the batch's
    // last FAILED call (name + error head) so a stop-right-after-a-failure gets a concrete retry.
    if (results.length > 0) workedSinceTodoGate = true
    lastToolFailure = undefined
    for (const r of results) {
      if (r.type !== 'tool_result' || !r.isError) continue
      const failedName = toolUses.find((tu) => tu.id === r.tool_use_id)?.name ?? 'a tool'
      lastToolFailure = `${failedName}: ${r.content.slice(0, 200)}`
    }
    if (toolUses.some((tu) => isVerifyCommand(tu, deps.check?.command) && !isFilteredVerify(tu))) verifiedEver = true // ADR-051: ≥1 real run — filtered runs don't count

    // ADR-059/075 POST-EDIT DIAGNOSTICS: the harness type-checks after a mutating turn and PUSHES the errors —
    // the model never has to know the Lsp tool exists (measured: it never called it). Default ON regardless of
    // sandbox: with a sandbox it runs `tsc` inside it (accurate); WITHOUT one (or if the container has died) it
    // falls back to the in-process LanguageService (postEditCheck.ts). Gating this on Boolean(sandbox) — the old
    // default — silently disabled the push for host-mode + the Tier-3 bench, the exact channel that stops the
    // blind type-churn. injects only when there are real errors; the verify gate still owns "done means built".
    if (deps.postEditCheck ?? true) {
      const edited = editedTsFiles(toolUses, results)
      if (edited.length > 0) {
        // Surface the harness type-check as ACTIVITY: it can take ~20s (tsc in the sandbox), and without a
        // status the UI looks idle between the edit and the next turn. A clean check emits nothing below, so
        // this is the only signal the agent is validating.
        yield { type: 'status', text: `Checking types in ${edited.length} edited file${edited.length === 1 ? '' : 's'}…` }
        const note = await postEditDiagnostics(edited, { cwd: deps.cwd, sandbox: deps.sandbox })
        // The missing-deps directive latches once per submit (installing takes turns — repeating the
        // reminder on every further write while npm runs would just be noise).
        if (note && !(note.missingDeps && depsNudged)) {
          if (note.missingDeps) depsNudged = true
          tracer.event({ t: 'post_edit_check', turn, files: edited.length })
          appendReminder(messages, note.text)
          yield { type: 'status', text: note.missingDeps ? 'Dependencies missing — asking the agent to npm install…' : 'Type errors after edit — feeding them back to the agent…' }
        }
      }
    }

    // ADR-058 READ-LOOP BREAKER (the Simmer live-lock): the Nth successful read of the same file with no
    // Write/Edit of it in between means reads are being consumed by narration/compaction, not by action.
    // Inject the act-now directive per crossing file (a mutation resets its counter, so a genuine new
    // investigation of the same file later can fire again).
    if (canMutate && deps.verifyGate !== false) {
      for (const path of foldReadLoop(readLoopCounts, toolUses, results)) {
        tracer.event({ t: 'read_loop', turn, path })
        appendReminder(messages, buildReadLoopNudge(path))
        yield { type: 'status', text: 'Read loop detected — asking the agent to edit instead of re-reading…' }
      }
      // ADR-072 RE-EDIT BREAKER: the Nth successful edit of the same file — the model is likely thrashing a
      // file whose problem-source lives elsewhere (a theme token, a shared type). Point it at Grep/Lsp.
      for (const path of foldReEdit(reEditCounts, toolUses, results)) {
        tracer.event({ t: 're_edit', turn, path })
        appendReminder(messages, buildReEditNudge(path, reEditCount(reEditCounts, path)))
        yield { type: 'status', text: 'Repeated edits to one file — suggesting Grep/Lsp to find the source…' }
      }
      // IDENTICAL-CALL BREAKER: the same tool with the SAME arguments N times, with no mutation in between.
      // A mutation makes a repeat productive (re-running the check after a fix), so it clears the counters.
      if (toolUses.some((tu) => MUTATING.has(tu.name))) repeatCallCounts.clear()
      for (const tu of toolUses) {
        let key: string
        try {
          key = `${tu.name}:${JSON.stringify(tu.input ?? {})}`
        } catch {
          continue // unserializable args (cycles) — can't key it, skip rather than throw mid-turn
        }
        const n = (repeatCallCounts.get(key) ?? 0) + 1
        repeatCallCounts.set(key, n)
        if (n === REPEAT_CALL_LIMIT) {
          tracer.event({ t: 'repeat_call', turn, tool: tu.name })
          appendReminder(
            messages,
            `<system-reminder>You have now called ${tu.name} with IDENTICAL arguments ${n} times without changing anything in between. The same call returns the same result — this cannot make progress. Either act on the result you already have (edit a file, run the declared check and read its real error), or take a genuinely different step. Do not repeat that call. Do not reply to this note.</system-reminder>`,
          )
          yield { type: 'status', text: `Repeated ${tu.name} call — asking the agent to act on the result…` }
        }
      }

      // REPEAT-NARRATION BREAKER: the same opening prose N turns running ⇒ re-deciding, not progressing.
      // Compared on a normalized prefix (case/whitespace-insensitive) so trivial rewording still counts as a
      // repeat. Fires once per streak, then resets — a model that breaks out and later genuinely repeats can
      // trip it again.
      const narration = text.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 120)
      if (narration.length >= 40 && narration === lastNarration) {
        narrationRepeats++
        if (narrationRepeats >= NARRATION_REPEAT_LIMIT) {
          narrationRepeats = 0
          lastNarration = ''
          tracer.event({ t: 'narration_loop', turn })
          appendReminder(
            messages,
            '<system-reminder>You have now opened several turns with the SAME sentence — you are re-stating the diagnosis instead of progressing, and the repeated reads are not adding information. STOP restating it. Change strategy: take a DIFFERENT concrete action than the ones already tried (e.g. run the check/build and read its actual error text, grep for the symbol, or make the smallest edit that would prove or disprove your theory). Do not reply to this note.</system-reminder>',
          )
          yield { type: 'status', text: 'Repeating itself — asking the agent to change strategy…' }
        }
      } else {
        lastNarration = narration
        narrationRepeats = 0
      }
    }

    // PER-SUBMIT TOOL-CALL CAP: past the budget the model is thrashing, not converging. Fires ONCE per submit
    // and only nudges — a legitimately huge build must still be able to finish, so this asks for convergence
    // (or an honest "here's what's blocking") rather than cutting the turn off.
    toolCallsThisSubmit += toolUses.length
    if (!toolCapNudged && depth === 0 && toolCallsThisSubmit >= TOOL_CALL_CAP) {
      toolCapNudged = true
      tracer.event({ t: 'tool_cap', turn, calls: toolCallsThisSubmit })
      appendReminder(
        messages,
        `<system-reminder>You have made ${toolCallsThisSubmit} tool calls in this single request — far past the point where an approach that is working has converged. Stop exploring and CONVERGE now: finish the smallest complete version of what remains, run the declared check, and end the turn. If something is genuinely blocking you, say plainly what it is and what you tried instead of continuing to probe. Do not reply to this note.</system-reminder>`,
      )
      yield { type: 'status', text: 'Very long run — asking the agent to converge…' }
    }

    // ADR-058 MID-FLIGHT CHECK NUDGE: the terminal verify gate never fires while the model keeps calling
    // tools — a live-lock session edits at turn 8 and never verifies through turn 53. After N consecutive
    // turns of unverified-edit state, direct it to the check ONCE: compiler output is compaction-proof
    // ground truth and re-derives everything the masked reads knew.
    stalledVerifyTurns = editedSinceVerify ? stalledVerifyTurns + 1 : 0
    if (
      deps.verifyGate !== false &&
      !stalledVerifyNudged &&
      depth === 0 &&
      stalledVerifyTurns >= STALLED_VERIFY_TURNS
    ) {
      stalledVerifyNudged = true
      tracer.event({ t: 'stalled_verify', turn })
      appendReminder(messages, buildStalledVerifyNudge(deps.check))
      yield { type: 'status', text: 'Edits unverified for several turns — asking the agent to run the check…' }
    }

    // MID-FLIGHT AUDIT NUDGE: same blind spot as above, one rung further out. `pendingBeforeDone` is
    // non-empty exactly while edits are outstanding against a declared before-done tool, so counting turns
    // in that state needs no new bookkeeping. Fires after the verify nudge (a broken build is heard first).
    stalledAuditTurns = pendingBeforeDone.size > 0 ? stalledAuditTurns + 1 : 0
    if (
      deps.verifyGate !== false &&
      !stalledAuditNudged &&
      depth === 0 &&
      stalledAuditTurns >= STALLED_AUDIT_TURNS
    ) {
      stalledAuditNudged = true
      tracer.event({ t: 'stalled_audit', turn, tools: [...pendingBeforeDone] })
      appendReminder(messages, buildStalledAuditNudge([...pendingBeforeDone]))
      yield { type: 'status', text: 'Edits unaudited for several turns — asking the agent to check what is left…' }
    }

    // ADR-050 rung 2: harness-detected delegation reminder. Recognition ("I should delegate") is
    // meta-cognition weak/mid models don't do — so the LOOP watches bulk-read pressure and reminds ONCE.
    // Requires a known window (compaction plan) + the Subagent tool advertised (parent loops only —
    // children get a Subagent-less registry). Appended to the trailing tool_results message (ADR-034 style).
    readPressureTokens = foldReadPressure(readPressureTokens, toolUses, results)
    if (sawSubagent(toolUses)) subagentUsed = true
    const window = deps.compact?.plan.window
    if (
      deps.delegateNudge !== false &&
      !delegateNudged &&
      !subagentUsed &&
      window !== undefined &&
      readPressureTokens > window * READ_PRESSURE_FRACTION &&
      registry.list().some((t) => t.name === 'Subagent')
    ) {
      delegateNudged = true
      tracer.event({ t: 'delegate_nudge', turn, readTokens: readPressureTokens })
      appendReminder(messages, buildDelegateNudgeText())
      yield { type: 'status', text: 'Suggesting delegation for the remaining reads…' }
    }

    // ADR-056 rung 2: plan-first detect→remind. Measured (skills-2): the composite PROMPT rule produced
    // zero planner spawns while the simple skills mandate was obeyed — so the harness detects instead:
    // files are being written, no PLAN.md exists, the planner was never spawned → inject the EXACT call
    // once. ACTIVATION: the planner def itself declares `proactive: true` (policy lives in
    // the capability's own frontmatter, never a session flag). Presence alone = available, not enforced;
    // users silence the nudge by shadowing planner.md without the field.
    if (toolUses.some((tu) => tu.name === 'Subagent' && (tu.input as { agent?: string } | null)?.agent === 'planner')) plannerUsed = true
    if (
      depth === 0 &&
      !planNudged &&
      !plannerUsed &&
      (deps.agentDefs ?? []).some((d) => d.name === 'planner' && d.proactive) &&
      toolUses.some((tu) => (tu.name === 'Write' || tu.name === 'Edit' || tu.name === 'MultiEdit') && results.some((r) => r.type === 'tool_result' && r.tool_use_id === tu.id && !r.isError)) &&
      !existsSync(join(deps.cwd, 'PLAN.md'))
    ) {
      planNudged = true
      tracer.event({ t: 'plan_nudge', turn })
      appendReminder(
        messages,
        '<system-reminder>You are building without a plan. Call Subagent {agent: "planner", prompt: "<the user\'s full request>"} NOW — it writes PLAN.md; then continue implementing AGAINST that plan. This is a background note, NOT a new request: do not reply to it — make the call, then continue the ORIGINAL task.</system-reminder>',
      )
      yield { type: 'status', text: 'Asking the agent to plan first…' }
    }

    if (++turn >= maxTurns) {
      tracer.event({ t: 'turn_done', turns: turn })
      yield { type: 'status', text: `Stopped after ${maxTurns} turns.` }
      yield { type: 'turnDone', steps: turn }
      return
    }
    // loop → the next model call sees the tool results
  }
}
