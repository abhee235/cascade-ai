// tools/builtins/Write.ts — create or overwrite a file. NOT read-only (matters for Phase 6 concurrency).


import { z } from 'zod'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '../Tool'
import { normalizeText } from '../fileState'
import { lineDiff } from '../../utils/diff'
import { displayPath, ProjectPathError, resolveInProject } from '../projectPath'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to write, relative to the workspace or absolute.'),
  content: z.string().describe('The full content to write. Overwrites the file if it exists.'),
})

export const WriteTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Write',
  // ADR-037: deliberately NOT tier-sized — "overwrites the ENTIRE file / Read it first" prevents destroying
  // work the model hasn't seen; short enough to afford at every tier.
  description: `Create a NEW file, or COMPLETELY OVERWRITE an existing one, with the given UTF-8 content. Parent directories are created automatically.
Prefer Edit for changing part of a file — Write replaces the ENTIRE file, so it's easy to destroy content you didn't mean to. If the file already exists, Read it first so you don't overwrite work you haven't seen. Use Write for brand-new files or a deliberate full rewrite.`,
  inputSchema,
  activitySummary: (input) => `Writing ${input.file_path}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false, // writes can race — never parallelize

  async call(input, ctx) {
    let path: string
    try {
      path = resolveInProject(ctx.cwd, input.file_path, ctx.sandbox?.root, ctx.pathScope) // ADR-033: jail to the project root
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    try {
      const before = await readFile(path, 'utf8').catch(() => undefined) // undefined ⇒ new file
      await mkdir(dirname(path), { recursive: true }) // create parent dirs
      await writeFile(path, input.content, 'utf8')
      // ADR-032: a successful Write IS the freshest possible knowledge of the file — record it, so a
      // follow-up Edit doesn't get rejected with "modified since you read it" (measured, Simmer run 5:
      // two Write→Edit pairs each paid a rejection + a re-read turn for a file the model itself just wrote).
      if (ctx.readFileState) {
        const st = await stat(path).catch(() => undefined)
        ctx.readFileState.set(path, { content: normalizeText(input.content), timestamp: st?.mtimeMs ?? Date.now() })
      }
      return {
        content: `Wrote ${input.content.length} chars to ${input.file_path}`,
        display: {
          kind: 'fileEdit',
          path: displayPath(ctx.cwd, path), // ADR-033: show where it actually lives in the project, not the model's alias
          op: before === undefined ? 'create' : 'overwrite',
          diff: lineDiff(before ?? '', input.content),
        },
      }
    } catch (e) {
      // Return the error so the model can fix the path/retry (self-correction) — don't throw.
      return {
        content: `Error writing ${input.file_path}: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      }
    }
  },
}
