// tools/builtins/EnterPlanMode.ts — switch the session into PLAN MODE (ADR-044). Get the user's sign-off
// on the APPROACH before writing any code — high leverage for a weak model, which otherwise builds the
// wrong thing on a guessed approach. Reuses the existing `plan`
// permission mode (gate.ts): once in plan mode, checkPermission DENIES every write and allows only reads, so
// the model can explore + design but not mutate — until ExitPlanMode is approved.

import { z } from 'zod'
import type { Tool } from '../Tool'

const inputSchema = z.object({}) // no parameters — entering plan mode is the whole action

export const EnterPlanModeTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'EnterPlanMode',
  // The "on your own" guard is hard-won: models tend to detour into plan mode for ordinary tasks,
  // stalling work behind an approval the user never asked to give.
  description: `Enter PLAN MODE to agree the approach with the user before any code is written. Use it when the user asks for a plan, or for genuinely large/ambiguous implementation work spanning many files where the wrong approach would be costly. Do NOT enter plan mode on your own for ordinary tasks — a clear request, even multi-step, should just be done. In plan mode you can ONLY explore — Read, Glob, Grep, Lsp — every file write and shell command is blocked. Investigate the codebase, design a concrete approach, use AskUserQuestion if you must resolve an ambiguity, then call ExitPlanMode with your plan for approval. Never use it for pure research/understanding tasks (only when you will implement code).`,
  inputSchema,
  activitySummary: () => 'Entering plan mode',
  isReadOnly: () => true, // changes policy, not the filesystem → auto-allowed
  isConcurrencySafe: () => true,

  async call(_input, ctx) {
    const perm = ctx.permission
    if (!perm) return { content: 'Plan mode is unavailable in this session.', isError: true }
    if (perm.state.mode !== 'plan') perm.state.priorMode = perm.state.mode // remember where to return on approval
    perm.state.mode = 'plan'
    return {
      content:
        'Entered PLAN MODE. Writes and commands are now blocked — explore read-only (Read/Glob/Grep/Lsp) to understand the code, design a concrete implementation plan, then call ExitPlanMode with the plan for the user to approve.',
    }
  },
}
