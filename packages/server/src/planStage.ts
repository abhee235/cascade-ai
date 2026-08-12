// planStage.ts — deterministic plan-first orchestration (ADR-056 rung 3).
//
// Measured (planner-1): the advisory nudge fired on cue and a 36B model READ it, reasoned about it, and
// declined — "I have all the information I need." A reminder has no teeth, and adding teeth in core
// (blocking writes) would bake builder policy into a package the extension shares, plus risk deadlock.
// So the BUILDER product enforces planning the way hosted builders do: as a pipeline STAGE the model never
// gets to vote on. On the FIRST message of a fresh project, the server runs the planner as its own
// TOP-LEVEL session; only after PLAN.md exists does the builder session see the user's message.
//
// Top-level (not a subagent) buys the v1.1 wish for free: the planner's AskUserQuestion flows through
// the normal event channel to the real user — the clarify step finally works. Core stays policy-free:
// this file is the ONLY place that knows "fresh builder projects plan first".

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentChildInstructions,
  createSession,
  loadAgentDefs,
  loadSkills,
  type AgentDef,
  type CascadeSession,
  type Message,
  type ModelProvider,
  type Sandbox,
  type Tracer,
} from '@cascade/core'

/**
 * Should a plan stage run before this submit? Yes only when ALL hold:
 *  - the conversation is FRESH (first message — mid-project plan deletion is the core nudge's job, not
 *    a surprise re-stage), and
 *  - no PLAN.md exists (a new chat on an already-planned project skips straight to building), and
 *  - a mounted planner declares `proactive: true` (same frontmatter contract as the core nudge — the
 *    capability opts in; shadowing planner.md without the field disables BOTH rungs).
 * Returns the def to run, or undefined.
 */
export function needsPlanStage(dir: string, historyLength: number, agentDirs: string[]): AgentDef | undefined {
  if (historyLength > 0) return undefined
  if (existsSync(join(dir, 'PLAN.md'))) return undefined
  return loadAgentDefs(agentDirs).find((d) => d.name === 'planner' && d.proactive)
}

export interface PlannerSessionOptions {
  dir: string
  provider: ModelProvider
  model: string
  skillDirs: string[]
  sandbox?: Sandbox
  tracer?: Tracer
  /** Eval fidelity: pinned windows carry over to the stage too. */
  contextWindow?: number
  /** A number pins the cap; 'auto' derives it from the window (core's recommendedMaxOutputTokens) — the
   *  same contract as the builder session, so the planner's thinking is bounded by the same ratio. */
  maxOutputTokens?: number | 'auto'
}

/** The planner as its own top-level session: the def's body is its system prompt, its `tools:` allowlist
 *  is enforced by the session (SessionOptions.tools), its `skills:` are preloaded. Disposable — one
 *  submit, then dispose. */
export function createPlannerSession(def: AgentDef, opts: PlannerSessionOptions): CascadeSession {
  return createSession({
    cwd: opts.dir,
    provider: opts.provider,
    model: opts.model,
    sandbox: opts.sandbox,
    // The planner only reads + writes PLAN.md; prompting for that inside a fresh sandboxed project would
    // be noise (mirrors the builder's own sandboxed-⇒-bypass rule).
    mode: 'bypass',
    extraInstructions: agentChildInstructions(def, loadSkills(opts.skillDirs)),
    tools: def.tools,
    maxTurns: def.maxTurns ?? 10,
    skillDirs: opts.skillDirs, // the Skill tool itself (the def allowlists it)
    // No check command applies to writing a plan — the verify gate would demand a build for a .md file.
    verifyGate: false,
    autoMemory: false, // one-shot session; nothing durable to curate
    loadProjectHooks: false, // same safety rule as the builder: the project dir is model-writable
    tracer: opts.tracer,
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens,
  })
}

/** The plain text of the last assistant message in a conversation (its concluding words). */
function lastAssistantText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role !== 'assistant') continue
    const text = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    if (text.trim()) return text.trim()
  }
  return ''
}

/**
 * Guarantee a PLAN.md exists after the stage. Measured (planner-6): the Write(PLAN.md) grant reliably
 * STOPS the planner building, but whether it then WRITES PLAN.md vs. just SPEAKS the plan in its final
 * message is non-deterministic (planner-4 wrote it; planner-6 dumped it into chat and never wrote). So the
 * stage persists the plan itself: if the planner already wrote PLAN.md, keep it; otherwise fall back to its
 * final message (which IS the plan), stripped to the first markdown heading so any "I'm in planner mode…"
 * preamble is dropped. Belt (the grant) and suspenders (this). Returns true if a plan now exists on disk.
 */
/** MINIMUM VIABLE PLAN (iterate-7 forensics): a degraded planner session once yielded a 64-char
 *  conversational fragment which was faithfully persisted — and a junk PLAN.md is WORSE than none: it
 *  suppresses the rung-2 plan nudge AND pins noise into every builder turn. A plan must have a heading
 *  and enough body to plausibly carry the sections. */
const MIN_PLAN_CHARS = 200

/**
 * The one-retry salvage nudge for a stage that ended with NO plan on disk and none in the final message.
 * Measured (dokar/qwen3.5-9B 2026-08-09): the planner composed three good clarifying questions as PROSE,
 * ended its text "Let me ask these questions:" — and called nothing. Questions only reach the user through
 * the AskUserQuestion tool; spoken questions are a protocol violation the model cannot see, and the stage
 * silently fell through to the builder, which assumed everything. The nudge names the violation and the
 * tool; the caller runs ONE extra submit with it before the ensurePlanPersisted fallback.
 */
/** The revise nudge for a plan that EXISTS but is unusable (see planQualityIssues). */
export function planReviseNudge(issues: string[]): string {
  return (
    '<system-reminder>Your PLAN.md needs one revision before the build can use it:\n' +
    issues.map((i) => `- ${i}`).join('\n') +
    '\nRewrite PLAN.md now with those fixed, keeping every section it already has. Load Skill {name: "design"} first if you have not — it defines the presets, the blocks, and the imagery routing. Do not reply to this note.</system-reminder>'
  )
}

export function planSalvageNudge(session: CascadeSession): string {
  const spokeQuestions = /\?/.test(lastAssistantText(session.getHistory()))
  return (
    '<system-reminder>Your planning turn ended with NO plan file and NO question asked. ' +
    (spokeQuestions
      ? 'You wrote clarifying questions as plain TEXT — the user never saw them: questions only reach the user through the AskUserQuestion tool. Call AskUserQuestion NOW with your questions (2 at most, concrete options). After the answers — or if you can proceed on reasonable assumptions — produce the plan: terse markdown starting with a # heading (or Write PLAN.md).'
      : 'Produce the plan NOW: terse markdown starting with a # heading (or Write PLAN.md). If one critical detail truly blocks planning, ask it first with the AskUserQuestion tool.') +
    ' Do not reply to this note.</system-reminder>'
  )
}

/** The pin cap in core's systemPrompt (PIN_CAP_CHARS). A plan longer than this is silently TRUNCATED in
 *  the builder's context — it reads a contract that stops mid-sentence and never learns it was cut. */
const PLAN_PIN_CAP = 2_500

/**
 * What is WRONG with a persisted plan, as fixable instructions. Empty ⇒ the plan is usable.
 *
 * Measured (qwen36-agentic-iq4, builder-shop, 2026-08-11): a 35B planner wrote a 4,797-char plan (2.7x
 * its stated cap, so the pinned copy truncated), SKIPPED the Design section entirely, and — having never
 * loaded the design skill — planned "emoji-only product images", which the design system bans outright
 * and design-lint fails on. PLAN.md is pinned as THE contract on every turn, so a malformed plan poisons
 * every build turn that follows: the same failure shape as the context-file contamination, except from a
 * document this harness produced itself. Prompt text alone did not hold a 35B here, so the stage checks.
 */
export function planQualityIssues(text: string): string[] {
  const issues: string[] = []
  if (text.length > PLAN_PIN_CAP) {
    issues.push(
      `it is ${text.length} characters — the builder only ever sees the first ${PLAN_PIN_CAP}, so everything past that is INVISIBLE to it. Cut it under ${PLAN_PIN_CAP} by tightening lines, not by dropping sections.`,
    )
  }
  if (!/^\s*(?:#{1,3}\s*|\*\*)Design\b/im.test(text)) {
    issues.push(
      'it has no **Design** section. Add one naming the preset (a file in src/themes/), the BLOCK composition per view, and the imagery source — without it the builder invents styling, and the usual result is emoji-as-images, which the design system bans.',
    )
  }
  const emoji = text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu) ?? []
  if (emoji.length >= 3 || /\bemoji\b/i.test(text)) {
    issues.push(
      'it plans EMOJI as imagery. An emoji is never an image here: name `<Photo web="<subject>" seed={id}>` for a grid of distinct items, `photoFor()` for a single hero, `<ArtImage>` for abstract art.',
    )
  }
  // The ROUTING token (design-overhaul P3 slice 5). PLAN.md is re-read every builder turn, so a
  // `category:` in it re-states which category skill to load on EVERY turn — far more durable than a
  // single inference made from the brief on turn one and then compacted away. Missing ⇒ the builder
  // falls back to guessing from the prompt, which is exactly how a shop gets built without the commerce
  // view contract. Accepted values mirror the mounted category skills.
  if (!/\bcategory:\s*(commerce|dashboard|landing|app-shell|game|none)\b/i.test(text)) {
    issues.push(
      'its Design line has no `category:` token. Start that line with `category: <commerce|dashboard|landing|app-shell|game|none>` — the builder reads it off the plan every turn to load the matching skill, which carries that category\'s view contract and reference page.',
    )
  }
  // Line-scan rather than one multiline regex: `photoFor` is CORRECT for a single hero, and only
  // becomes the repeat bug when the plan applies it per item.
  const perItem = /per (product|item|card)|each (product|item|card)|grid/i
  if (text.split(/\r?\n/).some((line) => /photoFor/i.test(line) && perItem.test(line))) {
    issues.push(
      'it plans `photoFor()` for a GRID. The bundled pack holds ~2 photos per category, so every card would show the same picture — use `<Photo web="<subject>" seed={id}>` per item; keep `photoFor()` for a single hero.',
    )
  }
  return issues
}

export function ensurePlanPersisted(dir: string, session: CascadeSession): boolean {
  const planPath = join(dir, 'PLAN.md')
  if (existsSync(planPath)) return true // the planner wrote it — the clean, structured path
  const text = lastAssistantText(session.getHistory())
  if (!text) return false // the planner produced nothing to persist
  // Drop any conversational preamble before the plan proper (the first markdown heading, e.g. "# … Plan").
  const headingAt = text.search(/^#{1,3} /m)
  if (headingAt < 0) return false // no heading anywhere ⇒ this is chatter, not a plan
  const plan = text.slice(headingAt)
  if (plan.length < MIN_PLAN_CHARS) return false // fragment ⇒ leave NO file (the nudge stays armed)
  writeFileSync(planPath, plan)
  return true
}
