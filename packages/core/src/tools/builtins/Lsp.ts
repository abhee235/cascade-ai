// tools/builtins/Lsp.ts — real semantic code intelligence for TS/JS (CORE-PARITY: LSP).
// Backed by the in-process TypeScript LanguageService (lsp/tsService.ts).
//
// NAVIGATION ONLY (definition/references/hover) over project SOURCE — works everywhere, no sandbox needed.
// Diagnostics are deliberately NOT a pull op here (ADR-075): type errors are PUSHED after every edit by the
// post-edit check (agent/postEditCheck.ts). A weak model won't remember to pull them, and a pull `diagnostics`
// op that runs a DIFFERENT check than the push (different scope/moment) can DISAGREE with it — two answers to
// "does my code compile" is exactly the thrash we're removing. So: push diagnostics, pull navigation.

import { z } from 'zod'
import type { Tool } from '../Tool'
import { ProjectPathError, resolveInProject } from '../projectPath'
import { tsDefinition, tsHover, tsReferences, type LspLocation } from '../../lsp/tsService'

const inputSchema = z.object({
  op: z
    .enum(['definition', 'references', 'hover'])
    .describe('definition = where the symbol is defined · references = every use of it · hover = its type/signature.'),
  file: z.string().describe('Project-relative path to a .ts/.tsx/.js/.jsx file, e.g. "src/App.tsx".'),
  line: z.number().int().positive().optional().describe('1-based line of the symbol (required for all ops).'),
  column: z.number().int().positive().optional().describe('1-based column of the symbol (required for all ops).'),
})

const fmtLoc = (l: LspLocation): string => `${l.file}:${l.line}:${l.column}`

export const LspTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Lsp',
  description: `Semantic code navigation for TypeScript/JavaScript — the compiler's understanding, not text matching. Jump to where a symbol is defined (op:"definition"), find EVERY use before a rename/refactor (op:"references"), or see a symbol's type (op:"hover"). All ops need the exact line+column of the symbol. Prefer this over Grep when you need semantic truth (the real definition / all callers), not lines that happen to contain the text. (Type errors are reported to you automatically after each edit — you do not need this tool to check whether your code compiles.)`,
  inputSchema,
  activitySummary: (input) => `Lsp ${input.op}: ${input.file}${input.line ? `:${input.line}` : ''}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, ctx) {
    // Confine the file to the project (ADR-033) and get a project-relative path for the LanguageService.
    let abspath: string
    try {
      abspath = resolveInProject(ctx.cwd, input.file, ctx.sandbox?.root, ctx.pathScope)
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }

    if (input.line === undefined || input.column === undefined) {
      return { content: `op "${input.op}" needs both line and column (1-based) of the symbol.`, isError: true }
    }
    try {
      if (input.op === 'definition') {
        const defs = tsDefinition(ctx.cwd, abspath, input.line, input.column)
        return { content: defs.length ? defs.map(fmtLoc).join('\n') : 'No definition found at that position.' }
      }
      if (input.op === 'references') {
        const refs = tsReferences(ctx.cwd, abspath, input.line, input.column)
        return { content: refs.length ? `${refs.length} reference(s):\n${refs.map(fmtLoc).join('\n')}` : 'No references found at that position.' }
      }
      const hover = tsHover(ctx.cwd, abspath, input.line, input.column)
      return { content: hover ? `\`\`\`ts\n${hover}\n\`\`\`` : 'No type information at that position.' }
    } catch (e) {
      return { content: `Lsp ${input.op} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
