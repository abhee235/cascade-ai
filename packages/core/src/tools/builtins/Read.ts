// tools/builtins/Read.ts — the first tool: read a file from the workspace.
// Read-only and simple on purpose — it's the tool that turns Cascade from a chatbot into an agent.

import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  file_path: z
    .string()
    .describe('Path to the file to read — relative to the workspace, or absolute.'),
})

const MAX_CHARS = 50_000 // keep the context sane; Phase 5 formalizes result limits

export const ReadTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Read',
  description:
    'Read a UTF-8 text file from the workspace and return its contents. Use it to inspect files before answering.',
  inputSchema,
  activitySummary: (input) => `Reading ${input.file_path}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const path = isAbsolute(input.file_path) ? input.file_path : resolve(ctx.cwd, input.file_path)
    try {
      const content = await readFile(path, 'utf8')
      return {
        content:
          content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS)}\n…[truncated]` : content,
      }
    } catch (err) {
      // Return the error AS the result (not a throw) so the model can self-correct (Phase 5 idea).
      return {
        content: `Error reading ${input.file_path}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
