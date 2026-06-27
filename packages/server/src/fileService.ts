// fileService.ts — read a project's files for the Code pane (M4). Files live in the host project dir (which
// is bind-mounted into the sandbox), so we read them host-side with node:fs. Server-only; paths returned to
// the client are RELATIVE to the project root (host paths never cross the wire). Guards: skip heavy dirs,
// cap file size, block path traversal, flag binaries.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { FileNode } from '@cascade/app-protocol'

const SKIP = new Set(['node_modules', '.git', 'dist', '.vite', '.next'])
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
