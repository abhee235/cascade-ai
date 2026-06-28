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
  /** Phase 12: delegate a subtask to a nested agent loop (own context + tool subset) → returns its final
   *  text. Injected by the loop (avoids an import cycle); absent at/over the depth cap. */
  spawnSubagent?(opts: { prompt: string; readOnly?: boolean }): Promise<string>
}

export interface ToolResult {
  /** Text returned to the model as the tool_result content. */
  content: string
  /** True if the tool failed — the model sees the error and can self-correct (Phase 5 lesson). */
  isError?: boolean
  /** M2: a generic UI rendering hint (e.g. a file-edit diff) — passed through to the frontend, not the model. */
  display?: import('../protocol').ToolDisplay
}

export interface Tool<I = unknown> {
  /** Unique name the model calls, e.g. "Read". */
  name: string
  /** What it does + when to use it — the model reads this to decide. */
  description: string
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
  /** Run the tool. Return text (and isError) — that becomes the tool_result.
   *  `onProgress` (Phase 8) lets long-running tools stream partial output (e.g. Bash stdout) live into
   *  the UI card as it arrives. Instantaneous tools ignore it. */
  call(input: I, ctx: ToolContext, onProgress?: (chunk: string) => void): Promise<ToolResult>
}
