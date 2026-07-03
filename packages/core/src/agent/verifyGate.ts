// agent/verifyGate.ts — the verification gate (ADR-049): refuse to accept "done" when files were edited
// but nothing verified them. STRUCTURAL, not prompt-hope: `false_done` was the dominant measured failure at
// BOTH ends of the model curve (3B: 7/10 after ADR-048 unblocked its args; both 35B polyglot fails), and
// prompt text alone ("verify before done" — ADR-037 tiers) demonstrably doesn't hold weak models to it.
//
// Shape mirrors the ADR-034 todo reminder: pure helpers here; the loop tracks one boolean and, at the
// terminal branch, injects a single <system-reminder> user turn and continues. ONE nudge per submit — the
// second terminal answer is accepted as-is (no infinite loops; "state why you can't verify" is a valid out).

import type { ContentBlock, Message } from '../protocol'
import type { ToolUse } from '../tools/runTool'

/** Tools whose success means project files changed — the state that demands verification. */
const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Shell commands that count as running verification. Matches the eval classifier's notion (report/classify)
 *  plus the common runners; word-boundary `tests?` also catches `run-tests.mjs` / `npm run test:x`. */
const VERIFY_COMMAND = /\btests?\b|--test|vitest|jest|mocha|pytest|tsc\b|npm +t\b/i

/** Did this tool call RUN verification? (Running is what counts — a failing suite feeds back on its own.) */
export function isVerifyCommand(tu: ToolUse): boolean {
	if (tu.name !== 'Bash') return false
	const cmd = (tu.input as { command?: string } | null)?.command
	return typeof cmd === 'string' && VERIFY_COMMAND.test(cmd)
}

/**
 * Fold one executed batch into the edited-since-verify state.
 * - a SUCCESSFUL file-mutating call sets it (there is now unverified work);
 * - ANY verify-command run clears it (even a red suite — its output feeds back and drives the next edit,
 *   so the loop is doing its job; the gate only exists to force the run to HAPPEN).
 */
export function foldVerifyState(prev: boolean, toolUses: ToolUse[], results: ContentBlock[]): boolean {
	const okById = new Map(results.map((r) => [r.type === 'tool_result' ? r.tool_use_id : '', r.type === 'tool_result' && !r.isError]))
	let edited = prev
	for (const tu of toolUses) {
		if (FILE_MUTATING_TOOLS.has(tu.name) && okById.get(tu.id)) edited = true
	}
	// Clear AFTER setting: an edit and a test run in the SAME batch means the test ran against the new state
	// (writes are serialized before subsequent reads in the scheduler; good enough at this granularity).
	for (const tu of toolUses) {
		if (isVerifyCommand(tu)) edited = false
	}
	return edited
}

/** The nudge, appended as a user turn (same channel as the ADR-034 reminder — reaches the model, not the UI). */
export function buildVerifyNudge(): Message {
	return {
		role: 'user',
		content:
			'<system-reminder>You edited files but never ran any verification. Before finishing: run the ' +
			"project's tests (e.g. `node --test`, `npm test`, or the project's documented test command) and " +
			'report the result — or state explicitly why verification is not possible here. Then give your ' +
			'final answer.</system-reminder>',
	}
}
