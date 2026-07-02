// tools/builtins/Edit.ts — replace an exact substring in a file. NOT read-only / not parallel-safe.
// Requires old_string to match uniquely.

import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from '../Tool'
import { lineDiff } from '../../utils/diff'
import { normalizeText } from '../fileState'
import { displayPath, ProjectPathError, resolveInProject } from '../projectPath'
import { readFreshnessError, refreshReadState } from '../editCore'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to edit, relative to the workspace or absolute.'),
  old_string: z.string().describe('Exact text to replace. Must appear EXACTLY ONCE in the file.'),
  new_string: z.string().describe('Replacement text.'),
})

export const EditTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Edit',
  // ADR-037: deliberately NOT tier-sized. Every rule below is load-bearing — exact match, uniqueness, the N→
  // prefix warning each prevent a concrete failed-edit retry loop, which costs far more tokens than the ~90
  // words saved. On a small window these rules matter MORE, not less.
  description: `Replace an exact substring in a file. Read the file first (required). old_string must match the current file content EXACTLY — including whitespace and indentation — and must appear EXACTLY ONCE; if it isn't unique, include more surrounding lines until it is. Keep edits small and targeted: prefer several precise edits over one sweeping one. new_string is the replacement (use "" to delete the matched text). Note: Read shows line-number prefixes like "  12→code" — do NOT include the "N→" prefix in old_string; match only the raw file text.`,
  inputSchema,
  activitySummary: (input) => `Editing ${input.file_path}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    let path: string
    try {
      path = resolveInProject(ctx.cwd, input.file_path, ctx.sandbox?.root) // ADR-033: jail to the project root
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    try {
      const content = normalizeText(await readFile(path, 'utf8')) // CRLF→LF so a Windows file matches the model's \n old_string

      // ── ADR-032: read-before-edit freshness (shared with MultiEdit; no-op when no cache is wired) ──
      const fs = ctx.readFileState
      const stale = await readFreshnessError(fs, path, input.file_path, content)
      if (stale) return { content: stale, isError: true }

      const count = content.split(input.old_string).length - 1
      // Uniqueness check → self-correction: tell the model to fix its old_string.
      if (count === 0) return { content: `old_string not found in ${input.file_path}.`, isError: true }
      if (count > 1)
        return {
          content: `old_string appears ${count}× in ${input.file_path}; it must be unique. Include surrounding context.`,
          isError: true,
        }
      const after = content.replace(input.old_string, () => input.new_string) // fn replacer ⇒ `$` in new_string stays literal
      await writeFile(path, after, 'utf8')
      await refreshReadState(fs, path, after)
      return {
        content: `Edited ${input.file_path} (1 replacement).`,
        display: { kind: 'fileEdit', path: displayPath(ctx.cwd, path), op: 'edit', diff: lineDiff(content, after) }, // ADR-033: project-relative
      }
    } catch (e) {
      return { content: `Error editing ${input.file_path}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
