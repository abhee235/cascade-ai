// tools/Tool.ts — the tool contract.
//
// A tool is the unit the model can invoke. `name` + `description` are sent to the model (so it knows
// when to use it); `inputSchema` (Zod) both validates the model's JSON args AND is converted to the
// JSON Schema we advertise; `call()` does the work and returns text fed back as the tool_result.

import type { ZodType } from 'zod'
import type { PermissionController } from '../permissions/gate'
import type { Tracer } from '../observability/tracer'

export interface ToolContext {
  cwd: string
  abortSignal: AbortSignal
  /** Phase 7: how tool calls are gated (mode + rules) and how 'ask' awaits the user. Optional so
   *  headless smoke tests can omit it (then everything is treated as allowed). */
  permission?: PermissionController
  /** ADR-023: forensic trace sink. Omit ⇒ untraced. */
  tracer?: Tracer
}

export interface ToolResult {
  /** Text returned to the model as the tool_result content. */
  content: string
  /** True if the tool failed — the model sees the error and can self-correct (Phase 5 lesson). */
  isError?: boolean
}

export interface Tool<I = unknown> {
  /** Unique name the model calls, e.g. "Read". */
  name: string
  /** What it does + when to use it — the model reads this to decide. */
  description: string
  /** Zod schema for the input: validates the model's args and is converted to JSON Schema. */
  inputSchema: ZodType<I>
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
