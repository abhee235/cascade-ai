// tools/editCore.ts — shared edit invariants used by BOTH Edit and MultiEdit, so they can never drift apart.
// The read-before-edit freshness guard (ADR-032) and its cache refresh are load-bearing for a weak model:
// they stop it editing a file it never actually read, or one that changed under it. Kept here (not duplicated)
// so a fix to one fixes the other.

import { stat } from 'node:fs/promises'
import type { FileStateCache } from './fileState'

/** ADR-032 read-before-edit freshness. Returns an error message (for the model to self-correct) or null when the
 *  file is safe to edit. No-op when no cache is wired (headless smokes). `content` is the CRLF-normalized file. */
export async function readFreshnessError(
  fs: FileStateCache | undefined,
  path: string,
  filePath: string,
  content: string,
): Promise<string | null> {
  if (!fs) return null
  const seen = fs.get(path)
  if (!seen) return `File ${filePath} has not been read yet. Read it first before editing it.`
  // mtime is the cheap "did it change?" signal; noisy on Windows (cloud-sync/antivirus touch it without real
  // changes), so for a FULL read we only block when the content actually differs. A PARTIAL (windowed) read
  // can't be verified by content — any mtime advance forces a re-read (a full-read gate).
  const mtime = await stat(path).then((s) => s.mtimeMs, () => 0)
  if (mtime > seen.timestamp && (seen.partial || content !== seen.content)) {
    return `File ${filePath} has been modified since you read it (by the user or a linter). Read it again before editing.`
  }
  return null
}

/** Refresh the freshness cache to the just-written content, so a SECOND edit to the same file in the same turn
 *  isn't wrongly rejected as "modified since read" (we are the modifier). */
export async function refreshReadState(fs: FileStateCache | undefined, path: string, after: string): Promise<void> {
  if (!fs) return
  await stat(path).then(
    (s) => fs.set(path, { content: after, timestamp: s.mtimeMs }),
    () => fs.set(path, { content: after, timestamp: Date.now() }),
  )
}
