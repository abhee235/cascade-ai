// tools/builtins/MemorySearch.ts — recall from archival (semantic) memory on demand (ADR-015, Tier 2).
// The "beyond always-injected memory" capability: only the relevant facts enter context, instead of injecting
// everything. Read-only + concurrency-safe ⇒ auto-allowed (no permission prompt).

import { z } from 'zod'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  query: z.string().describe('What to recall — a natural-language description of the fact/context you need.'),
  k: z.number().int().positive().optional().describe('Max results to return (default 5).'),
})

export const MemorySearchTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'MemorySearch',
  description:
    'Search long-term archival memory for facts relevant to a query (semantic search). Use to recall details saved in past sessions that are not in always-on core memory.',
  inputSchema,
  activitySummary: (input) => `Searching memory: ${input.query.length > 40 ? `${input.query.slice(0, 40)}…` : input.query}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, ctx) {
    if (!ctx.archival) return { content: 'Archival memory is unavailable.', isError: true }
    const hits = await ctx.archival.search(input.query, input.k ?? 5)
    if (!hits.length) return { content: 'No relevant memories found.' }
    return { content: hits.map((h, i) => `${i + 1}. ${h.text}`).join('\n') }
  },
}
