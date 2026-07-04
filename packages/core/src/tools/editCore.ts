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

// ── Item 4b: whitespace-tolerant edit matching ──────────────────────────────────────────────────────────────
//
// The measured failure (edit_mismatch class, 3B/20B traces): the model reproduces the CODE of old_string
// correctly but not its WHITESPACE — tabs retyped as spaces, wrong indent depth, trailing spaces dropped —
// and the exact matcher says "not found", so the model retries near-identical calls until the budget dies.
// A ladder of exact → curly-quote normalization only is enough for frontier models (they copy whitespace
// weak locals don't). Our extension, with two conservative rules that keep it safe:
//   1. A trimmed match only counts when it is UNIQUE (same contract as the exact matcher).
//   2. The replacement NEVER trusts the model's whitespace for the matched region: what gets replaced is the
//      FILE's own bytes, and new_string's indentation is remapped onto the file's real indent (linear prefix
//      swap, which preserves relative nesting).

export type EditTarget =
  | { ok: true; actual: string; newString: string; via: 'exact' | 'trimmed' }
  | { ok: false; reason: 'not-found' | 'not-unique'; message: string }

/**
 * Find what to replace in `content` for a model-supplied old_string/new_string pair.
 * Exact match first (count rules unchanged); on zero exact hits, a line-trimmed sliding-window match.
 */
export function findEditTarget(content: string, oldString: string, newString: string): EditTarget {
  const exactCount = content.split(oldString).length - 1
  if (exactCount === 1) return { ok: true, actual: oldString, newString, via: 'exact' }
  if (exactCount > 1) {
    return {
      ok: false,
      reason: 'not-unique',
      message: `old_string appears ${exactCount}× in the file; it must be unique. Include surrounding context.`,
    }
  }

  // Zero exact hits → line-trimmed window match over the file.
  const fileLines = content.split('\n')
  const oldLines = oldString.split('\n')
  while (oldLines.length && oldLines[0]!.trim() === '') oldLines.shift() // tolerate stray blank edges
  while (oldLines.length && oldLines[oldLines.length - 1]!.trim() === '') oldLines.pop()
  if (oldLines.length === 0) return { ok: false, reason: 'not-found', message: 'old_string not found in the file.' }

  const starts: number[] = []
  outer: for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j]!.trim() !== oldLines[j]!.trim()) continue outer
    }
    starts.push(i)
  }

  if (starts.length === 0) {
    // Near-miss hint: does any single old line exist somewhere? Points the model at "wrong surroundings"
    // instead of a bare not-found (its dominant recovery mistake is resending the same bytes).
    const probe = oldLines.find((l) => l.trim().length > 3)
    const seen = probe ? fileLines.findIndex((l) => l.trim() === probe.trim()) : -1
    return {
      ok: false,
      reason: 'not-found',
      message:
        seen >= 0
          ? `old_string not found — even ignoring indentation. Line ${seen + 1} of the file matches one of its lines, so the content may exist with DIFFERENT surrounding lines. Re-Read the file and copy the exact text.`
          : 'old_string not found in the file (even ignoring indentation). Re-Read the file and copy the exact text.',
    }
  }
  if (starts.length > 1) {
    return {
      ok: false,
      reason: 'not-unique',
      message: `old_string matches ${starts.length} places when ignoring indentation; it must be unique. Include surrounding context.`,
    }
  }

  // Unique trimmed match: replace the FILE's own bytes for that window…
  const start = starts[0]!
  const matched = fileLines.slice(start, start + oldLines.length)
  const actual = matched.join('\n')
  // …and remap new_string's indentation onto the file's, per DEPTH: the matched window gives exact pairs
  // (model wrote "    ", the file has "\t"; model "        " ↔ file "\t\t"), so every new_string line whose
  // indent the model used in old_string gets the file's indent for that same depth. A depth the model newly
  // introduced falls back to its longest known prefix, keeping the extra nesting verbatim.
  const indentMap = new Map<string, string>()
  for (let j = 0; j < oldLines.length; j++) {
    const mi = oldLines[j]!.match(/^[ \t]*/)![0]
    if (!indentMap.has(mi)) indentMap.set(mi, matched[j]!.match(/^[ \t]*/)![0])
  }
  const mapped = newString
    .split('\n')
    .map((l) => {
      if (l.trim() === '') return l
      const ind = l.match(/^[ \t]*/)![0]
      const exact = indentMap.get(ind)
      if (exact !== undefined) return exact + l.slice(ind.length)
      let best = ''
      for (const k of indentMap.keys()) if (ind.startsWith(k) && k.length > best.length) best = k
      return indentMap.has(best) ? indentMap.get(best)! + ind.slice(best.length) + l.slice(ind.length) : l
    })
    .join('\n')
  return { ok: true, actual, newString: mapped, via: 'trimmed' }
}
