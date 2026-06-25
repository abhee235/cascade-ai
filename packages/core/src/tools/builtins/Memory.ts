// tools/builtins/Memory.ts — let the agent SELF-EDIT its durable core memory (ADR-015). MemGPT-style
// curation, file-backed: append / replace / forget facts in CASCADE.md. It's a file write, so it passes
// the permission gate like any other write.

import { z } from 'zod'
import type { Tool } from '../Tool'
import { appendMemory, replaceMemory, forgetMemory } from '../../memory/memoryStore'

const inputSchema = z.object({
  action: z
    .enum(['append', 'replace', 'forget'])
    .describe('append a new durable fact, replace an existing one, or forget (remove) one'),
  fact: z
    .string()
    .describe('append: the fact to remember. replace: the NEW text. forget: text identifying the fact to remove.'),
  old: z.string().optional().describe('replace only: the existing memory text to replace.'),
  scope: z
    .enum(['core', 'archival'])
    .optional()
    .describe('core (default): always-in-context CASCADE.md, for stable preferences/conventions. archival: searchable long-term store for detailed/contextual facts (retrieved on demand via MemorySearch). Only "append" supports archival.'),
})

export const MemoryTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Memory',
  description:
    'Curate durable long-term memory (persists across sessions and New chat) in CASCADE.md. append a stable ' +
    'fact/preference/convention; replace one that changed; forget one that no longer applies. Use when the ' +
    'user asks you to remember/update/forget, or when you learn a stable fact worth keeping.',
  inputSchema,
  activitySummary: (input) => {
    const verb = input.action === 'append' ? 'Remembering' : input.action === 'replace' ? 'Updating memory' : 'Forgetting'
    return `${verb}: ${input.fact.length > 48 ? `${input.fact.slice(0, 48)}…` : input.fact}`
  },
  isReadOnly: () => false, // writes CASCADE.md
  isConcurrencySafe: () => false,

  async call(input, ctx) {
    if (input.action === 'append') {
      if (input.scope === 'archival') {
        if (!ctx.archival) return { content: 'Archival memory is unavailable.', isError: true }
        await ctx.archival.write(input.fact)
        return { content: 'Archived to searchable long-term memory.' }
      }
      return { content: `Remembered (${appendMemory(ctx.cwd, input.fact)}).` }
    }
    if (input.action === 'replace') {
      if (!input.old) return { content: 'replace requires `old` (the existing text to change).', isError: true }
      const r = replaceMemory(ctx.cwd, input.old, input.fact)
      return r.ok
        ? { content: `Updated memory (${r.path}).` }
        : { content: `Could not find "${input.old}" in memory to replace.`, isError: true }
    }
    const r = forgetMemory(ctx.cwd, input.fact)
    return r.ok
      ? { content: `Forgot from memory (${r.path}).` }
      : { content: `Could not find "${input.fact}" in memory to forget.`, isError: true }
  },
}
