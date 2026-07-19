// agent/readLoopGate.ts — harness-detected READ-LOOP breaker (ADR-058, the Simmer live-lock).
//
// Measured (builder trace 2026-07-19): 53 turns, the model diagnosed ONE type mismatch six times, re-read
// the same three files five times each, and never issued a single Edit. Cause: compaction masked each read
// before the model acted on it, and every re-read raised the pressure that triggered the next masking pass —
// a stable orbit ("I've been circling because my file reads keep getting compacted before I can act on
// them" — the model's own words, turn 40). Noticing the loop is meta-cognition weak models don't do; the
// LOOP can count. Fourth instance of the detect→remind idiom (ADR-034 todo reminder, ADR-049 verify gate,
// ADR-050 delegate nudge): pure fold helpers here, one counter map + one reminder in the loop.

import type { ContentBlock } from '../protocol'
import type { ToolUse } from '../tools/runTool'

/** Same-file reads with NO intervening Write/Edit of that file before the reminder fires. One re-read is
 *  normal (compaction may have eaten the first); a third read with still no edit is the loop signature. */
export const READ_LOOP_THRESHOLD = 3

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Counter key: paged reads (offset/limit — the ADR-052 read-in-bites flow) count per PAGE, so legitimately
 *  walking a large file in chunks never trips the gate; re-reading the SAME page does. */
function readKey(path: string, input: Record<string, unknown>): string {
	return input.offset !== undefined || input.limit !== undefined ? `${path}#${input.offset ?? 0}` : path
}

/**
 * Fold one executed tool batch into the per-file read counters. A successful Read increments its file's
 * count; a successful mutation of that file RESETS it (the read was consumed — the healthy cycle). Returns
 * the paths whose count crossed the threshold in THIS batch — each crossing fires exactly once, because the
 * count only equals the threshold the moment it is crossed (a later mutation resets, so a NEW loop on the
 * same file can legitimately fire again).
 */
export function foldReadLoop(counts: Map<string, number>, toolUses: ToolUse[], results: ContentBlock[]): string[] {
	const okById = new Map(results.map((r) => [r.type === 'tool_result' ? r.tool_use_id : '', r.type === 'tool_result' && !r.isError]))
	const crossed: string[] = []
	for (const tu of toolUses) {
		if (!okById.get(tu.id)) continue
		const input = (tu.input ?? {}) as Record<string, unknown>
		const path = typeof input.file_path === 'string' ? input.file_path.trim() : ''
		if (!path) continue
		if (tu.name === 'Read') {
			const key = readKey(path, input)
			const n = (counts.get(key) ?? 0) + 1
			counts.set(key, n)
			if (n === READ_LOOP_THRESHOLD) crossed.push(path)
		} else if (MUTATING_TOOLS.has(tu.name)) {
			// Consume every counter for this file — the whole-file key and any page keys.
			for (const key of [...counts.keys()]) {
				if (key === path || key.startsWith(`${path}#`)) counts.delete(key)
			}
		}
	}
	return crossed
}

/** The reminder — appended to the trailing tool_results message (ADR-034 channel: reaches the model, never
 *  the UI transcript). MUST end by re-anchoring to the task (the item-4 lesson: a reminder that reads like
 *  conversation gets ANSWERED instead of obeyed). */
export function buildReadLoopNudge(path: string): string {
	return (
		`<system-reminder>You have now read ${path} ${READ_LOOP_THRESHOLD} times without a single Write or Edit ` +
		'to it. You are looping: re-reading does not change a file, and each re-read costs context. You already ' +
		'know what is wrong — in your NEXT response, make the Write or Edit that fixes it as your FIRST tool ' +
		'call, before any further Read/Glob/Grep/TodoWrite. If the file is genuinely already correct, say so in ' +
		'one line and move to the next task. This is a background note, NOT a new request: do not reply to it — act.</system-reminder>'
	)
}
