// scripts/eval/classify.mts — the failure classifier (PLAN-eval E4). PURE: trace events + row facts in,
// failure class + evidence out — so it's unit-testable offline with synthetic traces (classify.test.mts).
//
// This is the "which knob do I tweak" router from docs/PLAN-eval.md: each class names the harness subsystem
// to fix. Rules run in PRIORITY order — mechanical tool-call failures first (they usually CAUSE the
// downstream symptoms), then context pressure, then loop budget, then code-quality classes.

/** Minimal shape of a parsed trace line (superset-tolerant: extra fields ignored). */
export interface TraceEv {
	t: string
	name?: string
	ok?: boolean
	content?: string
	input?: unknown
	kind?: string
	forced?: boolean
	message?: string
	toolUses?: { name: string }[]
	text?: string
}

export interface RowFacts {
	solved: boolean
	timedOut: boolean
	turns: number
	maxTurns: number
}

export type FailureClass =
	| 'solved'
	| 'backend_failure' // the MODEL BACKEND died/erred fatally (e.g. Ollama 500) → infra, NOT a harness/model signal
	| 'no_tool_use' // answered in prose; never used a tool → parse strategy / prompt tier
	| 'bad_tool_name' // called tools that don't exist → fuzzy-name hint in runTool
	| 'invalid_args' // repeated Zod rejections on the same tool → schema coercion / JSON repair
	| 'edit_mismatch' // repeated Edit freshness/uniqueness failures → Edit guidance / ADR-032 flow
	| 'context_thrash' // compaction storm / overflow recoveries → ADR-039 thresholds / ADR-038 window
	| 'loop_stall' // timed out or exhausted maxTurns → todo reminder / budgets / Ralph
	| 'false_done' // claimed done without ever running the project's tests → verify-before-done prompt
	| 'wrong_code' // edited + verified, still failing → likely model capability, not harness

export interface Classification {
	class: FailureClass
	evidence: string
}

const EDIT_ERROR = /not been read yet|modified since you read|old_string|not unique|not found in/i

export function classify(events: TraceEv[], row: RowFacts): Classification {
	if (row.solved) return { class: 'solved', evidence: 'check passed' }

	const toolCalls = events.filter((e) => e.t === 'tool_call')
	const failedResults = events.filter((e) => e.t === 'tool_result' && e.ok === false)
	const compactions = events.filter((e) => e.t === 'compaction')
	const overflowRecoveries = events.filter(
		(e) => e.t === 'error' && typeof e.message === 'string' && e.message.startsWith('recover(') && e.message.includes('overflow'),
	)

	// 0. The backend itself died (fatal, non-'recover(' error events — e.g. "The model call kept failing …
	//    HTTP 500 … llama-server terminated"). This is INFRA, not a harness or model signal — it must not
	//    pollute the routing table (a real run hit exactly this: Ollama crashed with 0xc0000409 mid-suite).
	const fatal = events.find(
		(e) => e.t === 'error' && typeof e.message === 'string' && !e.message.startsWith('recover(') && /kept failing|HTTP 5\d\d|terminated/i.test(e.message),
	)
	if (fatal) {
		return { class: 'backend_failure', evidence: fatal.message!.slice(0, 160) }
	}

	// 1. Never touched a tool at all — the model talked instead of acting (or its calls never reached the
	//    tool channel, which looks identical from the loop's side).
	if (toolCalls.length === 0) {
		return { class: 'no_tool_use', evidence: '0 tool calls in the whole run' }
	}

	// 2. Hallucinated tool names.
	const badName = failedResults.filter((e) => e.content?.startsWith('No such tool'))
	if (badName.length > 0) {
		return { class: 'bad_tool_name', evidence: `${badName.length}× "${badName[0]!.content}"` }
	}

	// 3. Repeated schema rejections on the SAME tool (one rejection is normal self-correction; repeats mean
	//    the model can't produce the shape).
	const invalidByTool = new Map<string, number>()
	for (const e of failedResults) {
		if (e.content?.startsWith('Invalid input for')) invalidByTool.set(e.name ?? '?', (invalidByTool.get(e.name ?? '?') ?? 0) + 1)
	}
	const worstInvalid = [...invalidByTool.entries()].sort((a, b) => b[1] - a[1])[0]
	if (worstInvalid && worstInvalid[1] >= 2) {
		return { class: 'invalid_args', evidence: `${worstInvalid[1]}× invalid input for ${worstInvalid[0]}` }
	}

	// 4. Repeated Edit failures (stale/unread file, old_string misses).
	const editFails = failedResults.filter((e) => (e.name === 'Edit' || e.name === 'Write') && EDIT_ERROR.test(e.content ?? ''))
	if (editFails.length >= 2) {
		return { class: 'edit_mismatch', evidence: `${editFails.length}× Edit/Write failures (freshness or old_string)` }
	}

	// 5. Context pressure dominated the run.
	if (compactions.length >= 3 || overflowRecoveries.length >= 1) {
		return {
			class: 'context_thrash',
			evidence: `${compactions.length} compactions${overflowRecoveries.length ? `, ${overflowRecoveries.length} overflow recoveries` : ''}`,
		}
	}

	// 6. Ran out of budget (wall clock or turns).
	if (row.timedOut || row.turns >= row.maxTurns) {
		return { class: 'loop_stall', evidence: row.timedOut ? 'wall-clock timeout' : `hit maxTurns (${row.maxTurns})` }
	}

	// 7. Finished under budget but never VERIFIED: no shell tool call that runs the project's tests.
	const ranTests = toolCalls.some((e) => {
		if (e.name !== 'Bash') return false
		const cmd = (e.input as { command?: string } | undefined)?.command ?? ''
		return /\btest\b|--test/.test(cmd)
	})
	if (!ranTests) {
		return { class: 'false_done', evidence: 'finished without ever running the tests' }
	}

	// 8. Acted AND verified, still wrong — points at capability, not the harness.
	return { class: 'wrong_code', evidence: 'edited + ran tests, check still fails' }
}

/** Parse a JSONL trace into events (tolerates blank/corrupt lines). */
export function parseTrace(jsonl: string): TraceEv[] {
	const out: TraceEv[] = []
	for (const line of jsonl.split('\n')) {
		if (!line.trim()) continue
		try {
			out.push(JSON.parse(line))
		} catch {
			/* skip corrupt line */
		}
	}
	return out
}
