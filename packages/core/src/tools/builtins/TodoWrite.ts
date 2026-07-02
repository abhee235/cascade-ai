// tools/builtins/TodoWrite.ts — the agent's session task checklist (CORE-PARITY tool B).
// The model resends the WHOLE list each call. We do three things with it: (1) surface it to the UI via a
// `todos` display hint (ADR-028 passthrough); (2) ADR-034: persist it to the session `todoStore` (per agent
// scope) so it survives compaction/restart and feeds the loop's periodic reminder; (3) ENFORCE the
// invariants a prompt can only ask for (one in_progress at a time) by surfacing a correction in the result.
// Read-only (no filesystem effect) → never prompts.

import { z } from 'zod'
import type { Tool } from '../Tool'

const todoSchema = z.object({
  content: z.string().min(1).describe('The task, imperative form (e.g. "Run the tests").'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('pending · in_progress · completed.'),
  activeForm: z.string().min(1).describe('Present-continuous form shown while in progress (e.g. "Running the tests").'),
})

const inputSchema = z.object({
  todos: z.array(todoSchema).describe('The full updated task list (send the entire list every time, not a delta).'),
})

// ADR-037: tier-sized (like Bash). The when-to-use guidance is advisory (compressible); the four rules are
// load-bearing — every tier keeps ALL of them, smaller tiers just say them in fewer words (the tool result +
// the periodic reminder also re-teach them, so the safety net is redundant by design).
const DESCRIPTION_FULL = `Keep a task list for this session — it tracks progress and shows the user what you're doing.

Use it PROACTIVELY for any non-trivial work: a task with 3+ steps, multiple requested items, or anything needing planning. Skip it for a single trivial task.

Rules:
- Capture the plan as todos right after getting the request.
- Mark a task in_progress BEFORE you start it; keep only ONE in_progress at a time.
- Mark a task completed IMMEDIATELY after finishing it (don't batch completions).
- Always send the ENTIRE list (with each task's current status), not just the changed item.`

const DESCRIPTION_LEAN = `Track a task list for the session (shown to the user). Use for any 3+-step task. Rules: plan first; ONE task in_progress before you work on it; mark completed immediately; always send the ENTIRE list.`

const todoWriteDescription = (tier: 'minimal' | 'lean' | 'full'): string =>
  tier === 'full' ? DESCRIPTION_FULL : DESCRIPTION_LEAN // lean/minimal share the condensed form — all 4 rules, fewest words

export const TodoWriteTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'TodoWrite',
  description: todoWriteDescription,
  inputSchema,
  activitySummary: (input) => {
    const done = input.todos.filter((t) => t.status === 'completed').length
    return `Updating todos (${done}/${input.todos.length})`
  },
  isReadOnly: () => true, // no filesystem effect → auto-allowed, never prompts
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    // ADR-034: store the authoritative list (per agent scope) so it survives compaction and a restart, and the
    // loop's periodic reminder + the UI read from it.
    ctx.todoStore?.set(ctx.depth ?? 0, input.todos)

    // Enforce the invariants the model is only ASKED to keep — surface a correction it can act on next call,
    // rather than silently trusting the prompt.
    const inProgress = input.todos.filter((t) => t.status === 'in_progress').length
    const pending = input.todos.filter((t) => t.status === 'pending').length
    let note = ''
    if (inProgress > 1) note = ` ⚠ ${inProgress} tasks are in_progress — keep exactly ONE; set the rest back to pending or mark them completed.`
    else if (inProgress === 0 && pending > 0) note = ` ⚠ No task is in_progress — mark the next one in_progress before you work on it.`

    return {
      content: `Todos updated.${note} Keep the list current — mark tasks in_progress before starting and completed as soon as they are done.`,
      display: { kind: 'todos', items: input.todos },
    }
  },
}
