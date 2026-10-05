// tools/fileState.ts — the "read-before-edit" freshness cache (ADR-032).
//
// WHY this exists: the Edit tool replaces an exact `old_string` the model proposes from MEMORY. If the model
// never actually Read the file, or the file changed since (user edit, a linter/formatter, an earlier tool),
// that memory is stale and the edit silently corrupts or misfires. So we record, per file, what the model
// last saw (`content`) and the file's mtime at that moment (`timestamp`); Edit/Write refuse to touch a file
// with no entry ("read it first") or a newer mtime whose content actually differs ("read it again").
//
// Kept lean (no LRU): a Map with resolve()-normalized keys (so a Read via relative path and an Edit via
// absolute path hit the same entry) and a soft entry cap. Lives on the SESSION so a Read in one turn stays
// valid for an Edit in a later turn (session-level, not per-turn).

import { resolve } from 'node:path'

export interface FileState {
  /** The file content the model last saw (CRLF-normalized to \n). Used for the modified-since fallback. */
  content: string
  /** The file's mtime (ms) when it was read — the cheap "did it change?" signal. */
  timestamp: number
  /** True when the model only saw PART of the file (we truncated a huge read) — Edit should require a full
   *  read first, since `old_string` may live past the truncation. (Set once Read gains offset/limit — C1.) */
  partial?: boolean
}

const MAX_ENTRIES = 200

export class FileStateCache {
  private readonly map = new Map<string, FileState>()
  private key(path: string): string {
    return resolve(path) // collapse .., make absolute → a relative Read and an absolute Edit agree
  }
  get(path: string): FileState | undefined {
    return this.map.get(this.key(path))
  }
  set(path: string, state: FileState): void {
    const k = this.key(path)
    this.map.delete(k) // re-insert so iteration order = recency (cheap LRU)
    this.map.set(k, state)
    if (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
}

/** Normalize line endings before matching/recording: CRLF→LF (a Windows `\r\n` file would
 *  otherwise never match a model's `\n` old_string), and strip a leading UTF-8 BOM. */
export function normalizeText(s: string): string {
  return s.replace(/^﻿/, '').replaceAll('\r\n', '\n')
}
