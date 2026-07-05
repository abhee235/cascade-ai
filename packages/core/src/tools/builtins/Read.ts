// tools/builtins/Read.ts — read a file from the workspace, with line numbers and offset/limit windowing,
// and a "too large → use offset" error. It also records read-freshness (ADR-032) so Edit/Write can require a fresh Read.

import { z } from 'zod'
import { readFile, stat } from 'node:fs/promises'
import type { Tool } from '../Tool'
import { normalizeText } from '../fileState'
import { ProjectPathError, resolveInProject } from '../projectPath'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to read — relative to the workspace, or absolute.'),
  offset: z.number().int().nonnegative().optional().describe('First line to read, 1-based. Leave it out unless the file is too big to read in one go.'),
  limit: z.number().int().positive().optional().describe('How many lines to return. Leave it out unless the file is too big to read in one go.'),
})

const MAX_CHARS = 50_000 // a whole-file read above this errors → the model must use offset/limit instead

// cat -n style: right-pad the line number to 6, then "→", then the line.
// Display only — the model strips the "N→" prefix when forming an Edit old_string (Edit matches the raw file).
function addLineNumbers(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((line, i) => {
      const n = String(startLine + i)
      return `${n.length >= 6 ? n : n.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}

export const ReadTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Read',
  // ADR-037: deliberately NOT tier-sized — the N→-prefix warning is load-bearing (a model that copies the
  // prefix into an Edit old_string breaks every edit); compact enough to afford at every tier.
  description:
    'Read a UTF-8 text file and return its contents with line numbers (e.g. "  12→const x = 1"). The "N→" prefix is for your reference only — when you copy text into an Edit\'s old_string, do NOT include it (Edit matches the raw file). For very large files, read a window with the offset (1-based start line) and limit (line count) parameters.',
  inputSchema,
  activitySummary: (input) => `Reading ${input.file_path}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    let path: string
    try {
      path = resolveInProject(ctx.cwd, input.file_path, ctx.sandbox?.root) // ADR-033: jail to the project root
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }
    try {
      const raw = normalizeText(await readFile(path, 'utf8')) // CRLF→LF so the model's view matches Edit's matching
      const lines = raw.split('\n')
      const ranged = input.offset !== undefined || input.limit !== undefined
      const start = input.offset && input.offset > 0 ? input.offset - 1 : 0 // 1-based → 0-based
      const end = input.limit !== undefined ? start + input.limit : lines.length
      const body = lines.slice(start, end).join('\n')

      // ADR-052: one bite must never exceed the plate. The cap is window-derived (ctx.readCapChars, from the
      // compaction plan) — on big windows it stays the flat 50k, so nothing changes there; on an 8k window a
      // whole-file read that would overflow the usable budget errors INSTEAD of blowing the window (measured:
      // a single 19k-char "legal" read started every longctx failure — overflow → compaction amputates the
      // read → the model re-reads → repeat until the clock dies). The error TEACHES the exact next call.
      const cap = ctx.readCapChars ?? MAX_CHARS
      if (body.length > cap) {
        // Suggested window: lines that fit in ~80% of the cap, from THIS file's real average line length
        // (+7 chars/line for the "N→" prefix). Floor keeps the suggestion useful even for long-line files.
        const avgLine = raw.length / Math.max(1, lines.length) + 7
        const fit = Math.max(20, Math.floor((cap * 0.8) / avgLine))
        const windowNote = ranged
          ? `Your offset/limit selects ~${Math.round(body.length / 1000)}k chars — more than fits.`
          : `The whole file is ${lines.length} lines (~${Math.round(raw.length / 1000)}k chars) — more than fits in your context.`
        return {
          content:
            `${windowNote} Read ${input.file_path} in parts of about ${fit} lines: ` +
            `Read {file_path: "${input.file_path}", offset: ${ranged ? Math.max(1, start + 1) : 1}, limit: ${fit}}, ` +
            `then continue with offset: ${(ranged ? Math.max(1, start + 1) : 1) + fit}. ` +
            'For bulk exploration across many files, use a Subagent instead — only its findings enter your context.',
          isError: true,
        }
      }

      // ADR-032: record what the model saw (raw, no line numbers) + the file's mtime, so Edit/Write can require
      // a fresh Read. `partial` for a windowed read — the model only saw a slice, so Edit must re-read on ANY
      // later change (it can't verify a slice by content).
      if (ctx.readFileState) {
        const mtime = await stat(path).then((s) => s.mtimeMs, () => Date.now())
        ctx.readFileState.set(path, { content: ranged ? body : raw, timestamp: mtime, partial: ranged })
      }

      const numbered = addLineNumbers(body, start + 1)
      // The cap above bounds `body`; the prefix can still nudge `numbered` past a FLAT cap — trim as before.
      return { content: numbered.length > cap * 1.2 ? `${numbered.slice(0, cap)}\n…[truncated — use a smaller limit]` : numbered }
    } catch (err) {
      // Return the error AS the result (not a throw) so the model can self-correct.
      return {
        content: `Error reading ${input.file_path}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
