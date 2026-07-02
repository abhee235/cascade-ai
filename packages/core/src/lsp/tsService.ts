// lsp/tsService.ts — real semantic code intelligence for TS/JS via the in-process TypeScript LanguageService.
//
// This is the "beyond Grep" capability (tool-faculties: LSP = "the actual definition and everyone who calls it"
// vs "lines containing foo"). We use `ts.LanguageService` directly rather than spawning typescript-language-
// server: in-process, no JSON-RPC lifecycle, and `typescript` is already a core dep. Session-warm + incremental
// (a Map cache keyed by project root; file versions are mtime-based, so edits by the Edit tool are picked up).
//
// Deployment note: this reads project SOURCE from disk (host / the sandbox bind mount, like the file tools), so
// navigation of the project's OWN symbols works everywhere. Type resolution INTO node_modules needs the project's
// installed deps — present on the host (extension) but in a Docker volume for the web sandbox — so DIAGNOSTICS
// are routed to the sandbox `tsc` by the Lsp tool when a sandbox is present; the LanguageService is the fallback.

import ts from 'typescript'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import fg from 'fast-glob'

export interface LspLocation {
  file: string // project-relative
  line: number // 1-based
  column: number // 1-based
}
export interface LspDiagnostic extends LspLocation {
  message: string
  code: number
  severity: 'error' | 'warning'
}

interface Cached {
  service: ts.LanguageService
  root: string
  files: string[] // absolute paths the host exposes
  options: ts.CompilerOptions
  refreshedAt: number
}

const CACHE = new Map<string, Cached>()
const SOURCE_GLOB = ['**/*.{ts,tsx,js,jsx,mts,cts}']
const IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**']

/** Parse the project's tsconfig.json if present (so its paths/jsx/target apply); otherwise sensible defaults. */
function compilerOptions(root: string): ts.CompilerOptions {
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
  if (cfgPath && existsSync(cfgPath)) {
    const read = ts.readConfigFile(cfgPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(cfgPath))
    return { ...parsed.options, noEmit: true }
  }
  return { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, allowJs: true, esModuleInterop: true, skipLibCheck: true, noEmit: true }
}

function getService(root: string): Cached {
  const key = resolve(root)
  const existing = CACHE.get(key)
  // Re-glob at most once per second so newly-created files (Write) join the program without rebuilding each call.
  if (existing && Date.now() - existing.refreshedAt < 1000) return existing

  // fast-glob returns FORWARD-slash absolute paths — TS's own convention (ts.sys normalizes to '/'). Keeping
  // everything forward-slash is critical on Windows: querying with a back-slash path would not match a program
  // file and the LanguageService would silently return nothing.
  const files = fg.sync(SOURCE_GLOB, { cwd: key, ignore: IGNORE, absolute: true })
  const options = existing?.options ?? compilerOptions(key)

  if (existing) {
    existing.files = files
    existing.refreshedAt = Date.now()
    return existing
  }

  // mtime-based versions: TS re-reads a file's snapshot whenever getScriptVersion changes → edits are picked up.
  const version = (f: string): string => {
    try {
      return String(statSync(f).mtimeMs)
    } catch {
      return '0'
    }
  }
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => CACHE.get(key)?.files ?? files,
    getScriptVersion: version,
    getScriptSnapshot: (f) => {
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8'))
      } catch {
        return undefined
      }
    },
    getCurrentDirectory: () => key,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const cached: Cached = { service, root: key, files, options, refreshedAt: Date.now() }
  CACHE.set(key, cached)
  return cached
}

/** Resolve a project file to the FORWARD-slash absolute path the TS program keys files by (see the glob note). */
function abs(root: string, file: string): string {
  return resolve(root, file).replace(/\\/g, '/')
}
const rel = (root: string, f: string): string => relative(resolve(root), f).replace(/\\/g, '/') || f

/** 1-based line/column → 0-based character offset in `text`. */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split('\n')
  let off = 0
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1
  return off + (column - 1)
}
/** 0-based offset → 1-based {line, column}. */
function lineColOf(text: string, offset: number): { line: number; column: number } {
  const upto = text.slice(0, offset).split('\n')
  return { line: upto.length, column: upto[upto.length - 1].length + 1 }
}

function spanToLocation(root: string, fileName: string, start: number): LspLocation {
  const text = readFileSync(fileName, 'utf8')
  const { line, column } = lineColOf(text, start)
  return { file: rel(root, fileName), line, column }
}

/** Semantic + syntactic diagnostics for one file (host-side; used when no sandbox tsc is available). */
export function tsDiagnostics(root: string, file: string): LspDiagnostic[] {
  const { service } = getService(root)
  const fileName = abs(root, file)
  const diags = [...service.getSyntacticDiagnostics(fileName), ...service.getSemanticDiagnostics(fileName)]
  return diags.map((d) => {
    const text = typeof d.file?.text === 'string' ? d.file.text : ''
    const { line, column } = d.start !== undefined ? lineColOf(text, d.start) : { line: 1, column: 1 }
    return {
      file: rel(root, fileName),
      line,
      column,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      code: d.code,
      severity: d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
    }
  })
}

/** Go-to-definition for the symbol at file:line:column. */
export function tsDefinition(root: string, file: string, line: number, column: number): LspLocation[] {
  const { service } = getService(root)
  const fileName = abs(root, file)
  const text = readFileSync(fileName, 'utf8')
  const defs = service.getDefinitionAtPosition(fileName, offsetOf(text, line, column)) ?? []
  return defs.map((d) => spanToLocation(root, d.fileName, d.textSpan.start))
}

/** Find all references to the symbol at file:line:column (the safe-rename win). */
export function tsReferences(root: string, file: string, line: number, column: number): LspLocation[] {
  const { service } = getService(root)
  const fileName = abs(root, file)
  const text = readFileSync(fileName, 'utf8')
  const refs = service.getReferencesAtPosition(fileName, offsetOf(text, line, column)) ?? []
  return refs.map((r) => spanToLocation(root, r.fileName, r.textSpan.start))
}

/** Type / signature (quick info) at file:line:column. */
export function tsHover(root: string, file: string, line: number, column: number): string | undefined {
  const { service } = getService(root)
  const fileName = abs(root, file)
  const text = readFileSync(fileName, 'utf8')
  const info = service.getQuickInfoAtPosition(fileName, offsetOf(text, line, column))
  if (!info) return undefined
  const sig = ts.displayPartsToString(info.displayParts)
  const doc = ts.displayPartsToString(info.documentation)
  return doc ? `${sig}\n\n${doc}` : sig
}

/** Drop a project's cached service (e.g. on session end / tsconfig change). Also exported for tests. */
export function clearLspCache(root?: string): void {
  if (root) CACHE.delete(resolve(root))
  else CACHE.clear()
}
