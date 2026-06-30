// tools/builtins/Write.ts — create or overwrite a file. NOT read-only (matters for Phase 6 concurrency).


import { z } from 'zod'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '../Tool'
import { lineDiff } from '../../utils/diff'
import { displayPath, ProjectPathError, resolveInProject } from '../projectPath'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to write, relative to the workspace or absolute.'),
  content: z.string().describe('The full content to write. Overwrites the file if it exists.'),
})

export const WriteTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Write',
  description: 'Write (create or overwrite) a UTF-8 text file with the given content.',
  inputSchema,
  activitySummary: (input) => `Writing ${input.file_path}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false, // writes can race — never parallelize

  async call(input, ctx) {
    let path: string
    try {
      path = resolveInProject(ctx.cwd, input.file_path, ctx.sandbox?.root) // ADR-033: jail to the project root
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    try {
      const before = await readFile(path, 'utf8').catch(() => undefined) // undefined ⇒ new file
      await mkdir(dirname(path), { recursive: true }) // create parent dirs
      await writeFile(path, input.content, 'utf8')
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
