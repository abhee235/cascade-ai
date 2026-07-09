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
  maxOutputTokens?: number
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
export function ensurePlanPersisted(dir: string, session: CascadeSession): boolean {
  const planPath = join(dir, 'PLAN.md')
  if (existsSync(planPath)) return true // the planner wrote it — the clean, structured path
  const text = lastAssistantText(session.getHistory())
  if (!text) return false // the planner produced nothing to persist
  // Drop any conversational preamble before the plan proper (the first markdown heading, e.g. "# … Plan").
  const headingAt = text.search(/^#{1,3} /m)
  const plan = headingAt >= 0 ? text.slice(headingAt) : text
  writeFileSync(planPath, plan)
  return true
}
