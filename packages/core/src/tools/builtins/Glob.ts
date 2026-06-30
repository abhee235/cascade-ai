// tools/builtins/Glob.ts — find files by glob pattern. Read-only.


import { z } from 'zod'
import fg from 'fast-glob'
import type { Tool } from '../Tool'
import { ProjectPathError, resolveInProject } from '../projectPath'

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
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    let cwd: string
    try {
      cwd = input.path ? resolveInProject(ctx.cwd, input.path, ctx.sandbox?.root) : ctx.cwd // ADR-033: jail to project
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    const files = await fg(input.pattern, { cwd, onlyFiles: true, dot: false, ignore: IGNORE })
    if (files.length === 0) return { content: 'No files matched.' }
    const shown = files.slice(0, MAX)
    const more = files.length > MAX ? `\n…(${files.length - MAX} more)` : ''
    return { content: `${shown.join('\n')}${more}\n\n${files.length} file(s)` }
  },
}
