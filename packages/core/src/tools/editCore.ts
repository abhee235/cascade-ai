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

/** Write-side twin of normalizeText (reads are CRLF→LF so the model's \n old_strings match): if the file ON
 *  DISK used CRLF, convert the edited LF text back before writing — otherwise the first Edit to a Windows file
 *  silently flips every line ending in it (a whole-file diff for a one-line change). Matching and the freshness
 *  cache stay LF-normalized; only the bytes written to disk keep the file's own style. */
export function restoreLineEndings(raw: string, edited: string): string {
	return raw.includes('\r\n') ? edited.replace(/\n/g, '\r\n') : edited
}

// ── Item 4b: whitespace-tolerant edit matching ──────────────────────────────────────────────────────────────
//
// The measured failure (edit_mismatch class, 3B/20B traces): the model reproduces the CODE of old_string
// correctly but not its WHITESPACE — tabs retyped as spaces, wrong indent depth, blank lines dropped — and
// the exact matcher says "not found", so the model retries near-identical calls until the budget dies.
// A ladder of exact → curly-quote normalization only is enough for frontier models (they copy whitespace
// reliably; weak locals don't). Our ladder, from strict to tolerant — a rung is consulted only when every stricter one
// found ZERO hits (never to break a stricter rung's ambiguity):
//   rung 1: exact substring
//   rung 2: line-trimmed window (indentation/edge whitespace forgiven, line structure identical)
//   rung 3: blank-line-insensitive window (rung 2, additionally forgiving dropped/added BLANK lines)
// Two conservative rules keep every rung safe:
//   1. A tolerant match only counts when it is UNIQUE (same contract as the exact matcher).
//   2. The replacement NEVER trusts the model's whitespace for the matched region: what gets replaced is the
//      FILE's own bytes, and new_string's indentation is remapped onto the file's real indent (linear prefix
//      swap, which preserves relative nesting).
// On a total miss, the error carries a SNIPPET of the file around the closest matching line, so the model can
// rebuild old_string from the error alone — without burning a Read round-trip (expensive on a queued backend).

export type EditTarget =
	| { ok: true; actual: string; newString: string; via: 'exact' | 'trimmed' | 'blanks' }
	| { ok: false; reason: 'not-found' | 'not-unique'; message: string }

/** Remap new_string's indentation onto the file's real indent, per DEPTH: the matched line pairs give exact
 *  prefix substitutions (model wrote "    " where the file has "\t"; "        " ↔ "\t\t"), so every new_string
 *  line whose indent the model used in old_string gets the file's indent for that same depth. A depth the model
 *  newly introduced falls back to its longest known prefix, keeping the extra nesting verbatim. */
function remapIndent(oldLines: string[], filePairLines: string[], newString: string): string {
	const indentMap = new Map<string, string>()
	for (let j = 0; j < oldLines.length; j++) {
		const mi = oldLines[j]!.match(/^[ \t]*/)![0]
		if (!indentMap.has(mi)) indentMap.set(mi, filePairLines[j]!.match(/^[ \t]*/)![0])
	}
	return newString
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
}

/**
 * Find what to replace in `content` for a model-supplied old_string/new_string pair.
 * The ladder above: exact → line-trimmed window → blank-line-insensitive window, unique-only at every rung.
 */
export function findEditTarget(content: string, oldString: string, newString: string): EditTarget {
	const exactCount = content.split(oldString).length - 1
	if (exactCount === 1) return { ok: true, actual: oldString, newString, via: 'exact' }
	if (exactCount > 1) {
		return {
			ok: false,
			reason: 'not-unique',
			message: `old_string appears ${exactCount}× in the file; it must be unique. Include more surrounding context to pin ONE occurrence — or, to change every occurrence, use MultiEdit with replace_all.`,
		}
	}

	// Zero exact hits → rung 2: line-trimmed window match over the file.
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

	if (starts.length === 1) {
		// Unique trimmed match: replace the FILE's own bytes for that window, remap new_string's indentation.
		const start = starts[0]!
		const matched = fileLines.slice(start, start + oldLines.length)
		return { ok: true, actual: matched.join('\n'), newString: remapIndent(oldLines, matched, newString), via: 'trimmed' }
	}
	if (starts.length > 1) {
		return {
			ok: false,
			reason: 'not-unique',
			message: `old_string matches ${starts.length} places when ignoring indentation; it must be unique. Include surrounding context.`,
		}
	}

	// Rung 3: blank-line-insensitive window. The model dropped (or invented) an empty line inside the block —
	// a measured mismatch shape the trimmed rung can't forgive because its windows must align line-for-line.
	// Compare only NON-BLANK lines; the replaced region is the file's own span from first to last matched line,
	// which by construction contains nothing but the matched lines plus the FILE's own blank lines.
	const nbIdx: number[] = []
	for (let i = 0; i < fileLines.length; i++) if (fileLines[i]!.trim() !== '') nbIdx.push(i)
	const nbOld = oldLines.filter((l) => l.trim() !== '')
	const bStarts: number[] = []
	outer2: for (let k = 0; k + nbOld.length <= nbIdx.length; k++) {
		for (let j = 0; j < nbOld.length; j++) {
			if (fileLines[nbIdx[k + j]!]!.trim() !== nbOld[j]!.trim()) continue outer2
		}
		bStarts.push(k)
	}

	if (bStarts.length === 1) {
		const from = nbIdx[bStarts[0]!]!
		const to = nbIdx[bStarts[0]! + nbOld.length - 1]!
		const matched = fileLines.slice(from, to + 1)
		const pairFile = nbOld.map((_, j) => fileLines[nbIdx[bStarts[0]! + j]!]!)
		return { ok: true, actual: matched.join('\n'), newString: remapIndent(nbOld, pairFile, newString), via: 'blanks' }
	}
	if (bStarts.length > 1) {
		return {
			ok: false,
			reason: 'not-unique',
			message: `old_string matches ${bStarts.length} places when ignoring indentation and blank lines; it must be unique. Include surrounding context.`,
		}
	}

	// Total miss. Near-miss diagnostic: find the first old line that DOES exist in the file (preferring
	// substantial lines over braces), and echo the file's real content around it — the model can rebuild
	// old_string straight from this error, without a Read round-trip (its dominant recovery mistake is
	// resending the same wrong bytes; its second is re-reading a file it "knows", at full-turn cost).
	let seen = -1
	for (const minLen of [4, 1]) {
		for (const l of nbOld) {
			if (l.trim().length < minLen) continue
			const i = fileLines.findIndex((f) => f.trim() === l.trim())
			if (i >= 0) {
				seen = i
				break
			}
		}
		if (seen >= 0) break
	}
	if (seen >= 0) {
		const from = Math.max(0, seen - 2)
		const to = Math.min(fileLines.length, seen + nbOld.length + 2)
		let snippet = fileLines.slice(from, to).join('\n')
		if (snippet.length > 800) snippet = `${snippet.slice(0, 800)}…`
		return {
			ok: false,
			reason: 'not-found',
			message: `old_string not found — even ignoring indentation and blank lines. Line ${seen + 1} of the file matches one of its lines, so your OTHER lines differ from what the file really contains (it may have changed since you composed this edit). The file around that line actually reads:\n---\n${snippet}\n---\nRebuild old_string by copying the EXACT lines from this snippet (or re-Read the file), then retry.`,
		}
	}
	return { ok: false, reason: 'not-found', message: 'old_string not found in the file (even ignoring indentation). Re-Read the file and copy the exact text.' }
}
