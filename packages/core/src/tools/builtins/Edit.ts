// tools/builtins/Edit.ts — replace an exact substring in a file. NOT read-only / not parallel-safe.
// Requires old_string to match uniquely.

import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to edit, relative to the workspace or absolute.'),
  old_string: z.string().describe('Exact text to replace. Must appear EXACTLY ONCE in the file.'),
  new_string: z.string().describe('Replacement text.'),
})

export const EditTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Edit',
  description: 'Replace an exact substring in a file. old_string must occur exactly once (add context to disambiguate).',
  inputSchema,
  activitySummary: (input) => `Editing ${input.file_path}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const path = isAbsolute(input.file_path) ? input.file_path : resolve(ctx.cwd, input.file_path)
    try {
      const content = await readFile(path, 'utf8')
      const count = content.split(input.old_string).length - 1
      // Uniqueness check → self-correction: tell the model to fix its old_string.
      if (count === 0) return { content: `old_string not found in ${input.file_path}.`, isError: true }
      if (count > 1)
        return {
          content: `old_string appears ${count}× in ${input.file_path}; it must be unique. Include surrounding context.`,
          isError: true,
        }
      await writeFile(path, content.replace(input.old_string, input.new_string), 'utf8')
      return { content: `Edited ${input.file_path} (1 replacement).` }
    } catch (e) {
      return { content: `Error editing ${input.file_path}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
