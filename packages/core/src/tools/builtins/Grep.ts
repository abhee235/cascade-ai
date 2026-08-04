// tools/builtins/Grep.ts — search file contents with a regex. Read-only.
// Reads files directly (no ripgrep dependency) for simplicity.

import { z } from 'zod'
import fg from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Tool } from '../Tool'
import { assertPatternInProject, isAllowedPath, ProjectPathError, resolveInProject } from '../projectPath'

const inputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z.string().optional().describe('Directory to search (relative to the workspace).'),
  glob: z.string().optional().describe('Limit to files matching this glob, e.g. "**/*.ts". Default: all files.'),
})

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**']

/** Ignore `node_modules` for ordinary project searches, but HONOUR an explicit request to look inside it.
 *  Measured (3D Solar build, 2026-08-03): the model needed the installed package's real types — the ground
 *  truth for a library-integration failure it had guessed at 10 times — and had to shell out to `grep -r`
 *  because these tools refused the path. Default hides the noise; explicit intent wins. */
const NODE_MODULES = '**/node_modules/**'
export function ignoresFor(pattern?: string, path?: string): string[] {
	const wantsDeps = `${pattern ?? ''} ${path ?? ''}`.includes('node_modules')
	return wantsDeps ? IGNORE.filter((g) => g !== NODE_MODULES) : IGNORE
}

const MAX_MATCHES = 100

export const GrepTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Grep',
  description: `Search file CONTENTS with a regular expression, across the project. Use this to find where something appears — a function, symbol, string, or usage. To find files by NAME/path instead, use Glob. Narrow the search with \`path\` (a subdirectory) and \`glob\` (e.g. "**/*.ts"). The pattern is a JavaScript REGEX and matching is case-sensitive — escape metacharacters when searching for literal code: to find \`foo(x)\` search \`foo\\(x\\)\`; same for \`. * + ? [ ] { } | $ ^\`. Returns matches as \`file:line: text\` (capped). node_modules/dist/.git are skipped by default — but naming node_modules in \`path\` or \`glob\` searches it, which is how you read an INSTALLED library's real types/exports instead of guessing at its API.`,
  inputSchema,
  activitySummary: (input) => `Searching "${input.pattern}"`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    // Invalid regex → return the error AS the result so the model can fix its pattern (self-correction).
    let re: RegExp
    try {
      re = new RegExp(input.pattern)
    } catch (e) {
      return { content: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }

    let cwd: string
    try {
      if (input.glob) assertPatternInProject(input.glob) // the GLOB FILTER can escape too, not just `path`
      cwd = input.path ? resolveInProject(ctx.cwd, input.path, ctx.sandbox?.root, ctx.pathScope) : ctx.cwd // ADR-033: jail to project
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    // Models pass a FILE as `path` constantly (ripgrep allows it; observed live: 6 identical ENOTDIR retries
    // burned a task's budget). Accept it: a file path means "search just this file".
    let files: string[]
    const stat = await import('node:fs/promises').then((m) => m.stat(cwd).catch(() => null))
    if (stat && stat.isFile()) {
      files = [cwd]
    } else {
      files = await fg(input.glob ?? '**/*', { cwd, onlyFiles: true, dot: false, ignore: ignoresFor(input.glob, input.path), absolute: true })
    }
    // Defense in depth: never READ a file outside the allowed roots, whatever the glob produced. (A
    // ripgrep walk can't leave its root; fast-glob can, so we filter.)
    files = files.filter((f) => isAllowedPath(ctx.cwd, f, ctx.pathScope?.roots))

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
