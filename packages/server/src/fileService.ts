// fileService.ts — read a project's files for the Code pane (M4). Files live in the host project dir (which
// is bind-mounted into the sandbox), so we read them host-side with node:fs. Server-only; paths returned to
// the client are RELATIVE to the project root (host paths never cross the wire). Guards: skip heavy dirs,
// cap file size, block path traversal, flag binaries.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { FileNode } from '@cascade/app-protocol'

// @babel/traverse ships as CJS; under ESM the callable hides behind `.default`.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse

// `.cascade` is Cascade's own bookkeeping (chat transcripts, todos) — not the user's project; don't show it.
const SKIP = new Set(['node_modules', '.git', 'dist', '.vite', '.next', '.cascade'])
const MAX_DEPTH = 10
const MAX_FILE_BYTES = 256 * 1024

/** Recursive file tree of `root`, dirs first then alphabetical, skipping heavy/generated dirs. */
export function readTree(root: string): FileNode[] {
  const walk = (dir: string, depth: number): FileNode[] => {
    if (depth > MAX_DEPTH) return []
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: FileNode[] = []
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const abs = join(dir, e.name)
      const path = relative(root, abs).split(sep).join('/') // forward slashes on the wire
      if (e.isDirectory()) nodes.push({ name: e.name, path, type: 'dir', children: walk(abs, depth + 1) })
      else nodes.push({ name: e.name, path, type: 'file' })
    }
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return nodes
  }
  return walk(root, 0)
}

/** Read one file's content (relative to `root`). Guards traversal, size, and binaries. */
export function readFile(root: string, relPath: string): { content: string; truncated: boolean } {
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Path is outside the project')
  if (statSync(abs).isDirectory()) throw new Error('Path is a directory')
  const buf = readFileSync(abs)
  if (buf.subarray(0, 8000).includes(0)) return { content: '⟨binary file⟩', truncated: false }
  const truncated = buf.length > MAX_FILE_BYTES
  return { content: buf.subarray(0, MAX_FILE_BYTES).toString('utf8'), truncated }
}

/** Write one file's content (relative to `root`). Same traversal guard as readFile. Used by the Code pane's
 *  save path and visual editing (M9); the bind-mounted dir means Vite's watcher hot-reloads the change. */
export function writeFile(root: string, relPath: string, content: string): void {
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Path is outside the project')
  if (statSync(abs).isDirectory()) throw new Error('Path is a directory')
  writeFileSync(abs, content, 'utf8')
}

/** Resolve a project-relative path to an absolute one, rejecting anything that escapes the project root. */
function safeResolve(root: string, relPath: string): string {
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Path is outside the project')
  return abs
}

/** Create an empty file at `relPath` (creating parent dirs). Throws if it already exists. (M9 file tree) */
export function createFile(root: string, relPath: string): void {
  const abs = safeResolve(root, relPath)
  if (existsSync(abs)) throw new Error('A file or folder with that name already exists')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, '', { flag: 'wx' })
}

/** Create a directory at `relPath` (recursive). (M9 file tree) */
export function makeDir(root: string, relPath: string): void {
  const abs = safeResolve(root, relPath)
  if (existsSync(abs)) throw new Error('A file or folder with that name already exists')
  mkdirSync(abs, { recursive: true })
}

/** Rename/move `from` → `to` (both project-relative). Creates the destination's parent dirs. (M9 file tree) */
export function renamePath(root: string, from: string, to: string): void {
  const absFrom = safeResolve(root, from)
  const absTo = safeResolve(root, to)
  if (!existsSync(absFrom)) throw new Error('Source no longer exists')
  if (existsSync(absTo)) throw new Error('A file or folder with that name already exists')
  mkdirSync(dirname(absTo), { recursive: true })
  renameSync(absFrom, absTo)
}

/** Delete a file or folder (recursive) at `relPath`. Refuses to delete the project root. (M9 file tree) */
export function deletePath(root: string, relPath: string): void {
  const abs = safeResolve(root, relPath)
  if (abs === root) throw new Error('Cannot delete the project root')
  rmSync(abs, { recursive: true, force: true })
}

// JSX text can't contain raw `< > { }` — they'd start a tag/expression. Escape so typed text lands literally.
const escapeJsxText = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/{/g, '&#123;').replace(/}/g, '&#125;')

/** Visual editing (M9): replace the text of the JSX element whose opening tag starts at `line:col` (1-based
 *  line, 0-based col — matching Babel/`data-cascade-loc`) with `newText`, and write the file. We PARSE only to
 *  locate the children's character range, then splice the original source string — so every other byte of the
 *  file (formatting, quotes, neighbouring code) is preserved. Returns true on success; false when the target
 *  isn't a plain-text container (self-closing, or it holds nested elements/expressions) — the caller then
 *  falls back to an AI edit instead of corrupting the JSX. */
export function editJsxTextAtLoc(root: string, relPath: string, line: number, col: number, newText: string): boolean {
  const { content } = readFile(root, relPath)
  const ast = parse(content, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  let start = -1
  let end = -1
  traverse(ast, {
    JSXElement(path) {
      const o = path.node.openingElement
      if (o.loc?.start.line !== line || o.loc?.start.column !== col) return
      const close = path.node.closingElement
      if (!close || close.start == null || o.end == null) return // self-closing → no text region
      if (path.node.children.some((k) => k.type !== 'JSXText')) return // holds elements/expressions → not inline-editable
      start = o.end
      end = close.start
      path.stop()
    },
  })
  if (start < 0) return false
  const next = content.slice(0, start) + escapeJsxText(newText) + content.slice(end)
  writeFile(root, relPath, next)
  return true
}

/** Visual editing (M9 toolbar): set the `className` of the JSX element whose opening tag starts at `line:col`
 *  to `className` (the parent computes the new Tailwind class string). Replaces an existing static className
 *  string in place, or inserts one after the tag name. Returns false for a dynamic className={expr} (we won't
 *  rewrite an expression) so the caller can surface that. Surgical splice — preserves the rest of the file. */
export function setClassAtLoc(root: string, relPath: string, line: number, col: number, className: string): boolean {
  const { content } = readFile(root, relPath)
  const ast = parse(content, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  let edit: { start: number; end: number; insert: boolean } | null = null
  traverse(ast, {
    JSXOpeningElement(path) {
      const o = path.node
      if (o.loc?.start.line !== line || o.loc?.start.column !== col) return
      const attr = o.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'className')
      if (attr && attr.type === 'JSXAttribute') {
        const v = attr.value
        const lit = v?.type === 'StringLiteral' ? v : v?.type === 'JSXExpressionContainer' && v.expression.type === 'StringLiteral' ? v.expression : null
        if (lit?.start != null && lit.end != null) edit = { start: lit.start + 1, end: lit.end - 1, insert: false } // inside the quotes
        // else: a dynamic className={expr} → leave it (edit stays null → returns false)
      } else if (o.name.type === 'JSXIdentifier' && o.name.end != null) {
        edit = { start: o.name.end, end: o.name.end, insert: true } // no className yet → insert after the tag name
      }
      path.stop()
    },
  })
  if (!edit) return false
  const e: { start: number; end: number; insert: boolean } = edit
  const ins = e.insert ? ` className="${className}"` : className
  writeFile(root, relPath, content.slice(0, e.start) + ins + content.slice(e.end))
  return true
}

/** A file's diff inputs: its content at the last git commit (`original`) vs now (`modified`). For the
 *  Monaco DiffEditor in the Code pane. `original` is '' for a new/untracked file or a non-git project. */
export function readDiff(root: string, relPath: string): { original: string; modified: string } {
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Path is outside the project')
  let modified = ''
  try {
    modified = readFile(root, relPath).content
  } catch {
    modified = '' // deleted or unreadable
  }
  let original = ''
  try {
    // git uses forward-slash paths; the wire already sends them that way.
    original = execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 })
  } catch {
    original = '' // new file, untracked, or no git
  }
  return { original, modified }
}
