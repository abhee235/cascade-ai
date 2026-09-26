// tools/builtins/Edit.ts — replace an exact substring in a file. NOT read-only / not parallel-safe.
// Requires old_string to match uniquely.

import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from '../Tool'
import { lineDiff } from '../../utils/diff'
import { normalizeText } from '../fileState'
import { assertWritable, displayPath, FrozenPathError, ProjectPathError, resolveInProject } from '../projectPath'
import { findEditTarget, readFreshnessError, refreshReadState, restoreLineEndings } from '../editCore'
import { escalationFields, fileWriteFence } from '../../sandbox/escalation'

// Param-level guidance: repeat the critical constraints ON the argument the model
// is about to generate — measured, edit-mismatch is the #1 weak-model tool failure, and the parameter
// description is the closest possible placement to where the mistake is made.
const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to edit, relative to the workspace or absolute.'),
  old_string: z
    .string()
    .describe(
      'The EXACT literal text to replace, copied verbatim from the file — all whitespace and indentation included, WITHOUT the "N→" line-number prefix Read displays. Must appear EXACTLY ONCE; if it is not unique, include 2–3 full lines of surrounding context before and after the target. Never regex- or backslash-escape it.',
    ),
  new_string: z.string().describe('The exact replacement text, indented correctly for its position. Use "" to delete the matched text.'),
  // ADR-070 step 2: the escalation pair — validated + consumed by the SCHEDULER (never read here).
  ...escalationFields,
})

export const EditTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Edit',
  // ADR-037: deliberately NOT tier-sized. Every rule below is load-bearing — exact match, uniqueness, the N→
  // prefix warning each prevent a concrete failed-edit retry loop, which costs far more tokens than the ~90
  // words saved. On a small window these rules matter MORE, not less.
  description: `Replace an exact substring in a file. Read the file first (required). old_string must match the current file content EXACTLY — including whitespace and indentation — and must appear EXACTLY ONCE; if it isn't unique, include 2–3 full lines of surrounding context before and after the target until it is. Provide the literal text, never a regex- or backslash-escaped version. Keep edits small and targeted: prefer several precise edits over one sweeping one. new_string is the replacement (use "" to delete the matched text). To change EVERY occurrence in a file (a rename), use MultiEdit with replace_all instead. Note: Read shows line-number prefixes like "  12→code" — do NOT include the "N→" prefix in old_string; match only the raw file text.`,
  inputSchema,
  activitySummary: (input) => `Editing ${input.file_path}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    // ADR-070 step 2: the read-only fence — before any path/filesystem work (widened ctx passes).
    const fence = fileWriteFence(ctx.sandboxPolicy)
    if (fence) return { content: fence, isError: true }
    let path: string
    try {
      path = resolveInProject(ctx.cwd, input.file_path, ctx.sandbox?.root, ctx.pathScope) // ADR-033: jail to the project root
      assertWritable(ctx.cwd, path, ctx.pathScope) // frozen prefixes (shared blocks/kit) reject writes
    } catch (e) {
      if (e instanceof ProjectPathError || e instanceof FrozenPathError) return { content: e.message, isError: true }
      throw e
    }
    try {
      const raw = await readFile(path, 'utf8')
      const content = normalizeText(raw) // CRLF→LF so a Windows file matches the model's \n old_string

      // ── ADR-032: read-before-edit freshness (shared with MultiEdit; no-op when no cache is wired) ──
      const fs = ctx.readFileState
      const stale = await readFreshnessError(fs, path, input.file_path, content)
      if (stale) return { content: stale, isError: true }

      // Item 4b: exact match first; on zero hits, a line-trimmed UNIQUE match that replaces the FILE's own
      // bytes and remaps new_string's indentation (weak models retype tabs/indent wrong — edit_mismatch class).
      const target = findEditTarget(content, input.old_string, input.new_string)
      if (!target.ok) return { content: `${target.message} (file: ${input.file_path})`, isError: true }
      const after = content.replace(target.actual, () => target.newString) // fn replacer ⇒ `$` in new_string stays literal
      await writeFile(path, restoreLineEndings(raw, after), 'utf8') // disk keeps its own CRLF/LF style
      await refreshReadState(fs, path, after) // cache stays LF-normalized (what matching compares against)
      return {
        content: `Edited ${input.file_path} (1 replacement${target.via !== 'exact' ? '; old_string matched with whitespace tolerance — indentation was taken from the file' : ''}).`,
        display: { kind: 'fileEdit', path: displayPath(ctx.cwd, path), op: 'edit', diff: lineDiff(content, after) }, // ADR-033: project-relative
      }
    } catch (e) {
      return { content: `Error editing ${input.file_path}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
