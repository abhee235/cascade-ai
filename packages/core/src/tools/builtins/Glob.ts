// tools/builtins/Glob.ts — find files by glob pattern. Read-only.


import { z } from 'zod'
import fg from 'fast-glob'
import { resolve } from 'node:path'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.tsx".'),
  path: z
    .string()
    .optional()
    .describe('Directory to search in (relative to the workspace). Defaults to the workspace root.'),
})

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**']
const MAX = 200

export const GlobTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Glob',
  description: 'Find files by glob pattern. Returns matching file paths (relative to the search dir).',
  inputSchema,
  activitySummary: (input) => `Finding ${input.pattern}`,
  async call(input, ctx) {
    const cwd = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd
    const files = await fg(input.pattern, { cwd, onlyFiles: true, dot: false, ignore: IGNORE })
    if (files.length === 0) return { content: 'No files matched.' }
    const shown = files.slice(0, MAX)
    const more = files.length > MAX ? `\n…(${files.length - MAX} more)` : ''
    return { content: `${shown.join('\n')}${more}\n\n${files.length} file(s)` }
  },
}
