// agent/verifyGate.ts — the verification gate (ADR-049): refuse to accept "done" when files were edited
// but nothing verified them. STRUCTURAL, not prompt-hope: `false_done` was the dominant measured failure at
// BOTH ends of the model curve (3B: 7/10 after ADR-048 unblocked its args; both 35B polyglot fails), and
// prompt text alone ("verify before done" — ADR-037 tiers) demonstrably doesn't hold weak models to it.
//
// Shape mirrors the ADR-034 todo reminder: pure helpers here; the loop tracks one boolean and, at the
// terminal branch, injects a single <system-reminder> user turn and continues. ONE nudge per submit — the
// second terminal answer is accepted as-is (no infinite loops; "state why you can't verify" is a valid out).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContentBlock, Message } from '../protocol'
import type { ToolUse } from '../tools/runTool'

/** Tools whose success means project files changed — the state that demands verification. */
const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Shell commands that count as running verification. Matches the eval classifier's notion (report/classify)
 *  plus the common runners; word-boundary `tests?` also catches `run-tests.mjs` / `npm run test:x`. */
const VERIFY_COMMAND = /\btests?\b|--test|vitest|jest|mocha|pytest|tsc\b|npm +t\b/i

/** Did this tool call RUN verification? The generic runner names, PLUS the session's own declared check —
 *  measured (shop-forensics-1): the check was `npm run build`, the model ran it UNPROMPTED, and the gate
 *  failed to recognize its own declared command, burning three redundant nudge turns. */
export function isVerifyCommand(tu: ToolUse, checkCommand?: string): boolean {
	if (tu.name !== 'Bash') return false
	const cmd = (tu.input as { command?: string } | null)?.command
	if (typeof cmd !== 'string') return false
	return VERIFY_COMMAND.test(cmd) || (checkCommand !== undefined && cmd.includes(checkCommand))
}

/**
 * Fold one executed batch into the edited-since-verify state.
 * - a SUCCESSFUL file-mutating call sets it (there is now unverified work);
 * - ANY verify-command run clears it (even a red suite — its output feeds back and drives the next edit,
 *   so the loop is doing its job; the gate only exists to force the run to HAPPEN).
 */
export function foldVerifyState(prev: boolean, toolUses: ToolUse[], results: ContentBlock[], checkCommand?: string): boolean {
	const okById = new Map(results.map((r) => [r.type === 'tool_result' ? r.tool_use_id : '', r.type === 'tool_result' && !r.isError]))
	let edited = prev
	for (const tu of toolUses) {
		if (FILE_MUTATING_TOOLS.has(tu.name) && okById.get(tu.id)) edited = true
	}
	// Clear AFTER setting: an edit and a test run in the SAME batch means the test ran against the new state
	// (writes are serialized before subsequent reads in the scheduler; good enough at this granularity).
	for (const tu of toolUses) {
		if (isVerifyCommand(tu, checkCommand)) edited = false
	}
	return edited
}

// ── ADR-051: gate hardening — evidence-driven, never tier-branched (inert without a resolved check) ────────

/** The check that defines "done" for this session, when one is known.
 *  `declared` = a frontend/eval explicitly passed it (the context stated done-means-check-passes);
 *  false = resolved from the repo (package.json) — informative for the nudge text, but it must not change
 *  WHEN the gate fires (chat over a repo with tests is still chat). */
export interface CheckCommand {
	command: string
	declared: boolean
}

/** Resolve the project's canonical check from package.json `scripts.test` (npm's placeholder excluded).
 *  Sync + once at session build; absent/unreadable ⇒ undefined (the gate keeps today's exact behavior). */
export function resolveCheckCommand(cwd: string): string | undefined {
	try {
		const raw = readFileSync(join(cwd, 'package.json'), 'utf8')
		const test = JSON.parse(raw)?.scripts?.test
		if (typeof test === 'string' && test.length > 0 && !/no test specified/i.test(test)) return 'npm test'
	} catch {
		/* no package.json / malformed — no signal, gate stays exactly as before */
	}
	return undefined
}

// ── ADR-058: the MID-FLIGHT check nudge (the Simmer live-lock) ─────────────────────────────────────────────
// The terminal gate only fires when the model STOPS calling tools — a live-lock never reaches it (measured:
// 53 turns of tool calls, edits since turn 8, `npm run build` never run once). Compiler/test output is
// compaction-PROOF ground truth: it arrives as a fresh tool result and re-derives everything the masked
// reads knew, which is exactly what a context-starved model needs to converge.

/** Consecutive turns of unverified-edit state before the mid-flight nudge fires (once per submit). */
export const STALLED_VERIFY_TURNS = 5

/** The mid-flight reminder — appended to the trailing tool_results message (ADR-034 channel). */
export function buildStalledVerifyNudge(check?: CheckCommand): string {
	const directive = check
		? `Run \`${check.command}\` with the Bash tool NOW`
		: 'Run the project check (its build or test command) with the Bash tool NOW'
	return (
		`<system-reminder>You have edited files but run no verification for ${STALLED_VERIFY_TURNS} turns. ` +
		`${directive} — its error list is the ground truth for what to fix next. Fix only the FIRST error it ` +
		'reports, run it again, and repeat. This is a background note, NOT a new request: do not reply to it — ' +
		'run the check, then continue the ORIGINAL task.</system-reminder>'
	)
}

/** The nudge, appended as a user turn (same channel as the ADR-034 reminder — reaches the model, not the UI).
 *  ADR-051: when the check command is KNOWN, the nudge is a DIRECTIVE naming it (weak models execute
 *  directives, not abstractions — measured); and it ends by re-anchoring to the task (the item-4 lesson:
 *  a reminder that reads like conversation gets answered instead of obeyed). */
export function buildVerifyNudge(check?: CheckCommand, noEdits = false): Message {
	const what = noEdits
		? 'You are finishing without having changed any files or run the project’s check.'
		: 'You edited files but never ran any verification.'
	const directive = check
		? `Run \`${check.command}\` with the Bash tool NOW and report the result — a failing run is useful information; silence is not.`
		: "Before finishing: run the project's tests (e.g. `node --test`, `npm test`, or the project's documented test command) and report the result — or state explicitly why verification is not possible here."
	return {
		role: 'user',
		content:
			`<system-reminder>${what} ${directive} This is a background note, NOT a new request: do not reply to it — ` +
			'run the check, then give your final answer on the ORIGINAL task.</system-reminder>',
	}
}
