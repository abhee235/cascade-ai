// tools/builtins/Subagent.ts — delegate a self-contained subtask to a NESTED agent (ADR-017). The subagent
// runs its own loop with its OWN context window and a tool subset, then returns only its final summary — so
// the parent's context stays clean (orchestrator–worker, one-way delegation).

import { z } from 'zod'
import type { Tool } from '../Tool'

const READ_ONLY_TYPES = new Set(['explore'])

const inputSchema = z.object({
  description: z.string().describe('A few words that name the task.'),
  prompt: z
    .string()
    .describe('The full, self-contained task for the subagent to perform autonomously — include ALL context it needs, since it starts with a fresh context window and only returns its final answer.'),
  subagent_type: z
    .enum(['general-purpose', 'explore'])
    .optional()
    .describe('explore = read-only investigation (Read/Glob/Grep/MemorySearch), returns findings. general-purpose = full tools. Default general-purpose.'),
})

export const SubagentTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Subagent',
  description:
    'Delegate a self-contained subtask to a nested agent that has its OWN context window. It works autonomously (its own tool calls) and returns only a final summary — keeping your context clean. Best for big searches or independent investigations. The subtask must be fully specified; you cannot talk to it mid-run, and it cannot delegate further.',
  inputSchema,
  activitySummary: (input) => `Subagent (${input.subagent_type ?? 'general-purpose'}): ${input.description}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async call(input, ctx) {
    if (!ctx.spawnSubagent) {
      return { content: 'Subagents cannot be nested further (depth limit). Complete the task directly with your tools.', isError: true }
    }
    try {
      const readOnly = READ_ONLY_TYPES.has(input.subagent_type ?? 'general-purpose')
      const result = await ctx.spawnSubagent({ prompt: input.prompt, readOnly })
      return { content: result }
    } catch (e) {
      // Don't crash the parent — return the failure so the model can adapt.
      return { content: `Subagent failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
