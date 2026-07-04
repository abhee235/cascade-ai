// agent/delegateNudge.ts — harness-detected delegation reminder (ADR-050, rung 2).
//
// The paradox this solves: delegation pays the most on small windows, but recognizing WHEN to delegate is
// meta-cognition weak/mid models don't do — measured: ZERO Subagent calls across all eval history, even on
// tasks built so delegation wins. Rung 1 (the imperative when-to in the tool description) targets strong
// models; this rung moves RECOGNITION into the harness: when a large share of the window has gone to bulk
// reads and no delegation has happened, inject ONE reminder. Third instance of the detect→remind idiom
// (todo reminder ADR-034, verify gate ADR-049) — the model only has to execute, never to notice.

import type { ContentBlock } from '../protocol'
import type { ToolUse } from '../tools/runTool'

/** Reads/searches whose RESULTS are the bulk that could have stayed in a subagent's context instead. */
const BULK_READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

/** Nudge when bulk-read results exceed this fraction of the context window. */
export const READ_PRESSURE_FRACTION = 0.35

/** Accumulate the token estimate (chars/4) of successful bulk-read results in this batch. */
export function foldReadPressure(prevTokens: number, toolUses: ToolUse[], results: ContentBlock[]): number {
	const byId = new Map(results.map((r) => [r.type === 'tool_result' ? r.tool_use_id : '', r]))
	let tokens = prevTokens
	for (const tu of toolUses) {
		if (!BULK_READ_TOOLS.has(tu.name)) continue
		const r = byId.get(tu.id)
		if (r && r.type === 'tool_result' && !r.isError) tokens += Math.ceil(r.content.length / 4)
	}
	return tokens
}

/** Did this batch delegate? (Once the model delegates on its own, the reminder has nothing to teach.) */
export function sawSubagent(toolUses: ToolUse[]): boolean {
	return toolUses.some((tu) => tu.name === 'Subagent')
}

/** The reminder text — appended to the trailing user (tool_results) message, ADR-034 style.
 *  MUST end by re-anchoring to the task: measured (item4-gate, longctx-wire-modules), a weak model whose
 *  reads were just compacted away ANSWERED this reminder conversationally ("Acknowledged — what would you
 *  like me to work on?") and ended its turn — the reminder was the last instruction-shaped text it saw. */
export function buildDelegateNudgeText(): string {
	return (
		'<system-reminder>A large share of your context window has gone to bulk file reads. For the REMAINING ' +
		"files or searches, use the Subagent tool instead of reading them yourself: one 'explore' subagent per " +
		'file/area with a precise question (e.g. "Find the registerPart call in src/vault/part3.js; report only ' +
		'that line"). Only the findings will enter your context. This is a background note, NOT a new request: ' +
		'do not reply to it or stop to acknowledge it — continue working on the ORIGINAL task now, using tools.</system-reminder>'
	)
}
