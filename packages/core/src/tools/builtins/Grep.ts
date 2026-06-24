// tools/builtins/Grep.ts — search file contents with a regex. Read-only.
// Reads files directly (no ripgrep dependency) for simplicity.

import { z } from 'zod'
import fg from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z.string().optional().describe('Directory to search (relative to the workspace).'),
  glob: z.string().optional().describe('Limit to files matching this glob, e.g. "**/*.ts". Default: all files.'),
})

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**']
const MAX_MATCHES = 100

export const GrepTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Grep',
  description: 'Search file contents with a regular expression. Returns matches as "file:line: text".',
  inputSchema,
  activitySummary: (input) => `Searching "${input.pattern}"`,
  async call(input, ctx) {
    // Invalid regex → return the error AS the result so the model can fix its pattern (self-correction).
    let re: RegExp
    try {
      re = new RegExp(input.pattern)
    } catch (e) {
      return { content: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }

    const cwd = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd
    const files = await fg(input.glob ?? '**/*', { cwd, onlyFiles: true, dot: false, ignore: IGNORE, absolute: true })

    const out: string[] = []
    for (const file of files) {
      if (out.length >= MAX_MATCHES) break
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue // binary / unreadable — skip
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) out.push(`${relative(ctx.cwd, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
      }
    }

    if (out.length === 0) return { content: 'No matches.' }
    const truncated = out.length >= MAX_MATCHES ? ' (truncated)' : ''
    return { content: `${out.join('\n')}\n\n${out.length} match(es)${truncated}` }
  },
}
