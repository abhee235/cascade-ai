// tools/builtins/Glob.ts — find files by glob pattern. Read-only.


import { z } from 'zod'
import fg from 'fast-glob'
import type { Tool } from '../Tool'
import { assertPatternInProject, displayPath, isAllowedPath, ProjectPathError, resolveInProject } from '../projectPath'

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
  description: `Find files by NAME or path pattern, fast, at any repo size. Use it when you know the shape of the filename (e.g. "src/**/*.tsx", "**/package.json"). To search file CONTENTS instead, use Grep. Optionally scope to a subdirectory with \`path\`. Returns matching paths (node_modules/dist/.git are ignored).`,
  inputSchema,
  activitySummary: (input) => `Finding ${input.pattern}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    let cwd: string
    try {
      assertPatternInProject(input.pattern) // the PATTERN can escape too, not just `path`
      cwd = input.path ? resolveInProject(ctx.cwd, input.path, ctx.sandbox?.root, ctx.pathScope) : ctx.cwd // ADR-033: jail to project
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    // Match absolutely, then keep only what is genuinely inside the project (defense in depth), and report
    // paths relative to the PROJECT ROOT so the model can feed them straight back to Read/Edit.
    const matched = await fg(input.pattern, { cwd, onlyFiles: true, dot: false, ignore: IGNORE, absolute: true })
    const files = matched.filter((f) => isAllowedPath(ctx.cwd, f, ctx.pathScope?.roots)).map((f) => displayPath(ctx.cwd, f))
    if (files.length === 0) return { content: 'No files matched.' }
    const shown = files.slice(0, MAX)
    const more = files.length > MAX ? `\n…(${files.length - MAX} more)` : ''
    return { content: `${shown.join('\n')}${more}\n\n${files.length} file(s)` }
  },
}
