// tools/builtins/MultiEdit.ts — apply SEVERAL exact-substring edits to ONE file, ATOMICALLY (ADR-042).
// Collapses N fragile Edit calls into one all-or-nothing operation — the back half of the
// `Lsp references → MultiEdit` rename workflow.
//
// The algorithm (sequential application, fused with our stronger invariants):
//   1. confine the path (ADR-033) · read + CRLF-normalize · read-before-edit freshness (ADR-032, shared w/ Edit)
//   2. apply edits IN ORDER to an in-memory copy — edit N sees the file as edits 1..N-1 left it:
//      • collision guard: N's old_string must NOT be a substring of an earlier new_string (else it would match
//        text just inserted — the key correctness rule)
//      • match rule: replace_all=false ⇒ old_string must be UNIQUE (our stricter contract); true ⇒ ≥1, replace all
//   3. write ONCE, only if every edit applied; any failure names the edit index and leaves the file untouched.

import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from '../Tool'
import { lineDiff } from '../../utils/diff'
import { normalizeText } from '../fileState'
import { displayPath, ProjectPathError, resolveInProject } from '../projectPath'
import { findEditTarget, readFreshnessError, refreshReadState } from '../editCore'

const editSchema = z.object({
  old_string: z.string().min(1).describe('Exact text to replace — must match the file EXACTLY at this point in the sequence.'),
  new_string: z.string().describe('Replacement text (use "" to delete the matched text).'),
  replace_all: z.boolean().optional().describe('Replace EVERY occurrence (e.g. renaming a variable). Default false → old_string must be unique.'),
})

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to edit, relative to the workspace.'),
  edits: z
    .array(editSchema)
    .min(1)
    .describe('Edits applied IN ORDER, each to the result of the previous. ALL-OR-NOTHING: if any edit fails, none are written.'),
})

export const MultiEditTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'MultiEdit',
  description: `Apply several exact-string edits to ONE file in a single atomic operation. Read the file first. Edits apply IN ORDER — each sees the result of the previous — and it's all-or-nothing: if any edit's old_string doesn't match (or isn't unique), NONE are written and you get one precise error naming the edit. Each old_string must match EXACTLY (whitespace included) and be unique, unless you set replace_all (for renames). Prefer this over many separate Edit calls when changing one file in multiple places.`,
  inputSchema,
  activitySummary: (input) => `Editing ${input.file_path} (${input.edits.length} edits)`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async call(input, ctx) {
    let path: string
    try {
      path = resolveInProject(ctx.cwd, input.file_path, ctx.sandbox?.root, ctx.pathScope) // ADR-033: jail to the project root
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    try {
      const original = normalizeText(await readFile(path, 'utf8')) // CRLF→LF so the model's \n old_strings match
      const fs = ctx.readFileState
      const stale = await readFreshnessError(fs, path, input.file_path, original)
      if (stale) return { content: stale, isError: true }

      let working = original
      const appliedNewStrings: string[] = []
      for (let i = 0; i < input.edits.length; i++) {
        const edit = input.edits[i]
        const label = `edit #${i + 1}`

        // Collision guard: this old_string must not match text an earlier edit inserted.
        const oldTrim = edit.old_string.replace(/\n+$/, '')
        if (oldTrim !== '' && appliedNewStrings.some((prev) => prev.includes(oldTrim))) {
          return { content: `${label}: old_string is a substring of an earlier edit's new_string — it would match text you just inserted. Reorder or combine the edits.`, isError: true }
        }

        if (edit.replace_all) {
          // replace_all stays EXACT-only: whitespace-tolerant matching of every occurrence is how a rename
          // silently rewrites lines the model never saw. Fuzziness is for the single-target case.
          const count = working.split(edit.old_string).length - 1
          if (count === 0) {
            return { content: `${label}: old_string not found${appliedNewStrings.length ? ' (after the earlier edits were applied)' : ''}. It must match the current file exactly.`, isError: true }
          }
          // Function replacer ⇒ `$`-sequences in new_string are inserted literally (not interpreted as $1/$&).
          working = working.replaceAll(edit.old_string, () => edit.new_string)
          appliedNewStrings.push(edit.new_string)
        } else {
          // Item 4b: exact → line-trimmed UNIQUE match (file's own bytes; indent remapped). Shared with Edit.
          const target = findEditTarget(working, edit.old_string, edit.new_string)
          if (!target.ok) {
            return { content: `${label}: ${target.message}${target.reason === 'not-found' && appliedNewStrings.length ? ' (note: earlier edits in this batch were already applied)' : ''}`, isError: true }
          }
          working = working.replace(target.actual, () => target.newString)
          appliedNewStrings.push(target.newString)
        }
      }

      if (working === original) return { content: `No change: the edits left ${input.file_path} identical.`, isError: true }

      await writeFile(path, working, 'utf8')
      await refreshReadState(fs, path, working)
      return {
        content: `Applied ${input.edits.length} edit(s) to ${input.file_path}.`,
        display: { kind: 'fileEdit', path: displayPath(ctx.cwd, path), op: 'edit', diff: lineDiff(original, working) },
      }
    } catch (e) {
      return { content: `Error editing ${input.file_path}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
