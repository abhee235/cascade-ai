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

// ADR-050: the old description said WHAT delegation is but never WHEN — and measured across ~60 eval tasks
// the model NEVER delegated, even on tasks where reading everything itself forced repeated compaction.
// Weak/mid models act on imperative condition→action rules, not on concepts ("keeps your context clean").
// Tier-sized (ADR-037): the trigger rule survives every tier; the elaboration compresses.
const DESCRIPTION_FULL = `Delegate a self-contained subtask to a nested agent with its OWN context window. It works autonomously and returns ONLY its final summary — the noise it reads never enters your context.

USE THIS whenever you would otherwise read or scan MULTIPLE large files just to find or extract something: send one 'explore' subagent per file/area with a precise question ("Find the registerPart call in src/vault/part3.js; report only the line") instead of reading them yourself. Rule of thumb: if the useful answer is much smaller than the text you'd have to read to find it, delegate the reading.

Do NOT use it for: a specific file you already know (use Read), a targeted text search (use Grep), or work spanning only 1-2 small files.

Contract: the prompt has to carry everything the subagent needs (it sees NONE of your conversation); you cannot talk to it mid-run; it cannot delegate further. subagent_type 'explore' = read-only investigation; 'general-purpose' = full tools.`

const DESCRIPTION_LEAN = `Delegate a self-contained subtask to a nested agent (own context window; returns only its final summary). USE whenever you'd otherwise read/scan MULTIPLE large files to find something small — one 'explore' subagent per file/area, precise question, only the finding comes back. NOT for a known file (Read) or a targeted search (Grep). Prompt must be fully self-contained; no mid-run interaction; cannot nest.`

const DESCRIPTION_MINIMAL = `Delegate a subtask to a nested agent (own context; returns only a summary). USE when you'd otherwise read several large files to find something small — send an 'explore' subagent per file with a precise question. Prompt must be self-contained.`

export const SubagentTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Subagent',
  description: (tier) => (tier === 'full' ? DESCRIPTION_FULL : tier === 'lean' ? DESCRIPTION_LEAN : DESCRIPTION_MINIMAL),
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
