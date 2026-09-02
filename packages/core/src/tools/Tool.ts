// tools/Tool.ts — the tool contract.
//
// A tool is the unit the model can invoke. `name` + `description` are sent to the model (so it knows
// when to use it); `inputSchema` (Zod) both validates the model's JSON args AND is converted to the
// JSON Schema we advertise; `call()` does the work and returns text fed back as the tool_result.

import type { ZodType } from 'zod'
import type { PermissionController } from '../permissions/gate'
import type { Tracer } from '../observability/tracer'
import type { ToolRegistry } from './toolRegistry'
import type { ArchivalMemory } from '../memory/archival'
import type { Sandbox } from '../sandbox/sandbox'
import type { FileStateCache } from './fileState'
import type { TodoStore } from './todoStore'
import type { Answers } from '../protocol'

/** ADR-043: the async bridge the SCHEDULER uses for a tool that requiresUserInteraction() — it yields a
 *  `question` ActivityEvent, then awaits `request(id)`. The session resolves it when the frontend calls
 *  respondQuestion(id, answers). Same shape as PermissionController; NOT serializable → lives on ToolContext. */
export interface AskController {
  request(id: string): Promise<Answers>
}

export interface ToolContext {
  cwd: string
  abortSignal: AbortSignal
  /** Phase 7: how tool calls are gated (mode + rules) and how 'ask' awaits the user. Optional so
   *  headless smoke tests can omit it (then everything is treated as allowed). */
  permission?: PermissionController
  /** ADR-023: forensic trace sink. Omit ⇒ untraced. */
  tracer?: Tracer
  /** Phase 9: the active tool set (builtins + ready MCP tools), so lookups/execution see MCP tools.
   *  Omit ⇒ builtins-only (defaultRegistry). */
  registry?: ToolRegistry
  /** Phase 10 (ADR-015): archival (semantic) memory the agent can write to and search on demand. */
  archival?: ArchivalMemory
  /** Phase 12 (ADR-017): nesting depth (0 = main agent). Used to cap subagent recursion. */
  depth?: number
  /** Phase 13.3: generic execution capability. When present, command-running tools (Bash) execute HERE
   *  (the server injects a per-project Docker sandbox); when absent, they run on the host. Core is agnostic. */
  sandbox?: Sandbox
  /** ADR-070: the standing file-effect policy this call runs under. Set by the loop (derived once per
   *  session); the SCHEDULER swaps in a widened copy for exactly one call when the user approves an
   *  escalation — tools read it, never write it. Absent ⇒ no policy enforcement (the extension). */
  sandboxPolicy?: import('../sandbox/policy').SandboxPolicy
  /** How file paths are confined (ADR-033 + the path-policy change): 'jail' (default — the sandboxed web
   *  builder refuses outside paths in the tool) vs 'prompt' (the extension — outside paths resolve and the
   *  permission gate asks), plus any additional allowed roots. Omit ⇒ jail to the project. */
  pathScope?: import('./projectPath').PathScope
  /** ADR-032: read-before-edit freshness. Read records {content, mtime} here; Edit/Write require an entry
   *  (the file was read) that hasn't gone stale. Session-scoped. Omit ⇒ no freshness enforcement. */
  readFileState?: FileStateCache
  /** ADR-034: the authoritative todo checklist (per agent scope), written by TodoWrite. Survives compaction
   *  so the loop's periodic reminder + the UI read a list that the transcript may have summarized away.
   *  Session-scoped. Omit ⇒ TodoWrite still works (display passthrough) but there's no stored list/reminder. */
  todoStore?: TodoStore
  /** ADR-043: the round-trip channel for AskUserQuestion — the scheduler yields a `question` event and awaits
   *  this. Omit ⇒ no interactive channel (headless / non-interactive), and the tool returns a clear error. */
  ask?: AskController
  /** ADR-036: project hook config (.cascade/hooks.json), loaded once by the session. Absent = no hooks. */
  hooks?: import('../hooks/hookRunner').HooksConfig
  /** ADR-052: window-derived cap (chars) on a single Read result — one bite must never exceed the plate.
   *  Set by the loop from the compaction plan; absent ⇒ the flat 50k default (big-window behavior). */
  readCapChars?: number
  /** Phase 12: delegate a subtask to a nested agent loop (own context + tool subset) → returns its final
   *  text. Injected by the loop (avoids an import cycle); absent at/over the depth cap.
   *  ADR-056: `agent` names a file-defined persona (own system prompt, tool allowlist, preloaded skills). */
  spawnSubagent?(opts: { prompt: string; readOnly?: boolean; agent?: string }): Promise<string>
}

export interface ToolResult {
  /** Text returned to the model as the tool_result content. */
  content: string
  /** True if the tool failed — the model sees the error and can self-correct (Phase 5 lesson). */
  isError?: boolean
  /** M2: a generic UI rendering hint (e.g. a file-edit diff) — passed through to the frontend, not the model. */
  display?: import('../protocol').ToolDisplay
  /** ADR-060: data-URI images the MODEL should SEE (vision). The loop attaches them as image blocks on the
   *  tool_results user message — tool_result content itself is text-only on every provider wire. */
  images?: string[]
}

export interface Tool<I = unknown> {
  /** Unique name the model calls, e.g. "Read". */
  name: string
  /** What it does + when to use it — the model reads this to decide. Advertised on EVERY request, so it's
   *  paid from the context window each turn. ADR-037: may be a function of the window tier — a 128k model
   *  affords the rich guidance; an 8k model gets the essentials (same strategy as the system prompt).
   *  The optional second arg is the EXECUTION platform for command tools ('posix' when a sandbox runs the
   *  commands, else the host) — Bash tailors its shell-syntax guidance to it. Both are stable per session,
   *  so descriptions stay KV-cache-stable. */
  description: string | ((tier: import('../llm/contextWindows').WindowTier, exec?: 'win32' | 'posix') => string)
  /** Zod schema for the input: validates the model's args AND is converted to JSON Schema (builtins).
   *  Optional because MCP tools (Phase 9) arrive with raw JSON Schema instead — see `parameters`. */
  inputSchema?: ZodType<I>
  /** Raw JSON Schema for the input, used as-is to advertise the tool (Phase 9: MCP tools have this, not a
   *  Zod schema). When present we skip Zod validation — the MCP server validates the args itself. */
  parameters?: Record<string, unknown>
  /** Present-tense activity line for the UI card, e.g. "Reading package.json". */
  activitySummary(input: I): string
  /** Does this call mutate state? Used for permissions (Phase 7). Method form because it can depend on
   *  input (Phase 8 Bash: `ls` is read-only, `rm` is not). Default when absent: false (assume it writes). */
  isReadOnly?(input: I): boolean
  /** Safe to run in parallel with other tools this turn? Default when absent: false (conservative).
   *  Read-only tools are safe; writes are not (they can race). Used by the scheduler (Phase 6). */
  isConcurrencySafe?(input: I): boolean
  /** ADR-043: this tool's effect IS a round-trip to the user (AskUserQuestion, ExitPlanMode). The scheduler
   *  yields a `question` event and awaits the answer via ctx.ask instead of running `call()`. Default: false. */
  requiresUserInteraction?(): boolean
  /** ADR-043/044: for a requiresUserInteraction tool, the question(s) to put to the user (AskUserQuestion returns
   *  its own; ExitPlanMode synthesizes an Approve/Revise question from the plan). */
  toQuestions?(input: I): import('../protocol').Question[]
  /** ADR-043/044: turn the user's answers into the tool_result — and optionally act on them (ExitPlanMode flips
   *  the permission mode on approval). Omit ⇒ the scheduler formats the answers as text. */
  applyAnswers?(input: I, answers: import('../protocol').Answers, ctx: ToolContext): ToolResult | Promise<ToolResult>
  /** Run the tool. Return text (and isError) — that becomes the tool_result.
   *  `onProgress` (Phase 8) lets long-running tools stream partial output (e.g. Bash stdout) live into
   *  the UI card as it arrives. Instantaneous tools ignore it. */
  call(input: I, ctx: ToolContext, onProgress?: (chunk: string) => void): Promise<ToolResult>
}
