// tools/builtins/Lsp.ts — real semantic code intelligence for TS/JS (CORE-PARITY: LSP).
// Backed by the in-process TypeScript LanguageService (lsp/tsService.ts).
//
// Two backends by op (see tsService's deployment note):
//   • navigation (definition/references/hover) → the LanguageService over project SOURCE (works everywhere).
//   • diagnostics → the SANDBOX `tsc` when a sandbox is present (accurate: it has the project's node_modules);
//     the host LanguageService is the fallback (extension / no sandbox).

import { z } from 'zod'
import type { Tool } from '../Tool'
import { ProjectPathError, resolveInProject } from '../projectPath'
import { tsDefinition, tsDiagnostics, tsHover, tsReferences, type LspDiagnostic, type LspLocation } from '../../lsp/tsService'

const inputSchema = z.object({
  op: z
    .enum(['diagnostics', 'definition', 'references', 'hover'])
    .describe('diagnostics = type/syntax errors in the file · definition = where the symbol is defined · references = every use of it · hover = its type/signature.'),
  file: z.string().describe('Project-relative path to a .ts/.tsx/.js/.jsx file, e.g. "src/App.tsx".'),
  line: z.number().int().positive().optional().describe('1-based line of the symbol (required for definition/references/hover).'),
  column: z.number().int().positive().optional().describe('1-based column of the symbol (required for definition/references/hover).'),
})

const fmtLoc = (l: LspLocation): string => `${l.file}:${l.line}:${l.column}`
const fmtDiag = (d: LspDiagnostic): string => `${d.file}:${d.line}:${d.column}: ${d.severity} TS${d.code}: ${d.message}`

// `src/App.tsx(12,7): error TS2304: Cannot find name 'x'.` — mirrors server/checkProject.ts's parser.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.*)$/

export const LspTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Lsp',
  description: `Semantic code intelligence for TypeScript/JavaScript — the compiler's understanding, not text matching. Use it to VERIFY a change compiles (op:"diagnostics"), to jump to where a symbol is defined (op:"definition"), to find EVERY use before a rename/refactor (op:"references"), or to see a symbol's type (op:"hover"). definition/references/hover need the exact line+column of the symbol. Prefer this over Grep when you need semantic truth (the real definition / all callers), not lines that happen to contain the text.`,
  inputSchema,
  activitySummary: (input) => `Lsp ${input.op}: ${input.file}${input.line ? `:${input.line}` : ''}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, ctx) {
    // Confine the file to the project (ADR-033) and get a project-relative path for the LanguageService.
    let abspath: string
    try {
      abspath = resolveInProject(ctx.cwd, input.file, ctx.sandbox?.root)
    } catch (e) {
      if (e instanceof ProjectPathError) return { content: e.message, isError: true }
      throw e
    }

    try {
      if (input.op === 'diagnostics') return await diagnostics(ctx, abspath, input.file)

      if (input.line === undefined || input.column === undefined) {
        return { content: `op "${input.op}" needs both line and column (1-based) of the symbol.`, isError: true }
      }
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

/** Diagnostics: run tsc in the sandbox when present (has node_modules → accurate), else the host LanguageService.
 *  Both are filtered to the requested file so the model gets a focused "did MY file compile" answer. */
async function diagnostics(ctx: Parameters<NonNullable<typeof LspTool.call>>[1], abspath: string, fileRel: string): Promise<{ content: string; isError?: boolean }> {
  if (ctx.sandbox) {
    const { output } = await ctx.sandbox.exec('npx tsc --noEmit --pretty false 2>&1')
    const wanted = fileRel.replace(/\\/g, '/').replace(/^\.?\//, '')
    const lines: string[] = []
    for (const raw of output.split('\n')) {
      const m = TSC_LINE.exec(raw.trim())
      if (!m) continue
      const f = m[1].replace(/\\/g, '/').replace(/^\.?\//, '')
      if (!f.endsWith(wanted) && !wanted.endsWith(f)) continue // just this file
      lines.push(`${m[1]}:${m[2]}:${m[3]}: ${m[4]} TS${m[5]}: ${m[6]}`)
    }
    return { content: lines.length ? lines.join('\n') : `No type errors in ${fileRel}.` }
  }
  const diags = tsDiagnostics(ctx.cwd, abspath)
  return { content: diags.length ? diags.map(fmtDiag).join('\n') : `No type errors in ${fileRel}.` }
}
