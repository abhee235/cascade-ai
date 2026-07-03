// llm/proseToolCalls.ts — rescue tool calls a weak model wrote as TEXT (ADR-047).
//
// The eval's weak-tier baseline (llama3.2:3b, 0/10) failed every task the same way: the model emitted
// well-formed tool-call JSON — {"name":"Glob","parameters":{…}} — inside a ```json fence in its TEXT,
// never on the native tool-call channel. The loop saw zero tool_use blocks → treated the turn as a final
// answer → task over. This module parses those text-channel calls so the provider can emit them as real
// tool_use events ([[model-capability-fallbacks]]: the fallback lives in the PROVIDER, not the loop).
//
// Safety properties (why this can't hurt a strong model — verified by the no-regression eval diff):
//   1. The provider only invokes it when the native channel produced ZERO tool calls.
//   2. A candidate only counts if its `name` matches a tool ACTUALLY ADVERTISED this turn — prose that
//      merely resembles a call (or names a hallucinated tool like "Rename") is ignored.
//   3. Only the FIRST valid call is executed (ReAct-style). Weak models plan whole speculative sequences
//      up front (the 3b emitted five calls including an Edit with empty old_string and a Write with
//      placeholder content); executing beyond the first would act on guesses. One call → real result →
//      the model re-plans next turn with actual information.

/** A tool call recovered from prose. `input` is the parsed arguments object (may be {}). */
export interface ProseToolCall {
	name: string
	input: Record<string, unknown>
}

/** Scan `text` for balanced top-level JSON objects (string/escape aware). Returns raw slices.
 *  A scanner, not JSON.parse-the-whole-thing: models emit SEVERAL objects back to back (newline-separated,
 *  no array brackets — exactly the observed 3b shape), which is not valid JSON as a whole. */
function scanJsonObjects(text: string): string[] {
	const out: string[] = []
	let depth = 0
	let start = -1
	let inString = false
	let escaped = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (inString) {
			if (escaped) escaped = false
			else if (ch === '\\') escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') {
			if (depth > 0) inString = true // strings outside any object can't be part of a candidate
			continue
		}
		if (ch === '{') {
			if (depth === 0) start = i
			depth++
		} else if (ch === '}') {
			if (depth > 0 && --depth === 0 && start !== -1) {
				out.push(text.slice(start, i + 1))
				start = -1
			}
		}
	}
	return out
}

/** The argument-object key, across the conventions weak models actually use. */
const ARG_KEYS = ['parameters', 'arguments', 'input', 'args'] as const

/** Try to interpret one parsed JSON value as a tool call against the advertised tool names. */
function asToolCall(parsed: unknown, byLower: Map<string, string>): ProseToolCall | null {
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
	const obj = parsed as Record<string, unknown>
	// name under `name` or `tool`; some models nest one level under `function` (OpenAI echo shape).
	const fn = typeof obj.function === 'object' && obj.function !== null ? (obj.function as Record<string, unknown>) : undefined
	const rawName = obj.name ?? obj.tool ?? fn?.name
	if (typeof rawName !== 'string') return null
	const name = byLower.get(rawName.toLowerCase())
	if (!name) return null // not an advertised tool (hallucinated, or prose that merely looks call-ish)
	for (const src of [obj, fn].filter(Boolean) as Record<string, unknown>[]) {
		for (const key of ARG_KEYS) {
			const v = src[key]
			if (typeof v === 'object' && v !== null && !Array.isArray(v)) return { name, input: v as Record<string, unknown> }
			// OpenAI-echo shape: arguments as a JSON STRING
			if (typeof v === 'string') {
				try {
					const p = JSON.parse(v)
					if (typeof p === 'object' && p !== null && !Array.isArray(p)) return { name, input: p }
				} catch {
					/* not JSON — keep looking */
				}
			}
		}
	}
	return { name, input: {} } // a bare {"name":"List"} style call with no args
}

/**
 * Extract tool calls the model wrote into its TEXT. Returns every valid candidate in order (the provider
 * decides how many to act on — currently the first). `toolNames` = the tools advertised this turn.
 */
export function extractProseToolCalls(text: string, toolNames: readonly string[]): ProseToolCall[] {
	if (!text || toolNames.length === 0) return []
	// Cheap gate before any scanning: the text must even mention a call-ish key.
	if (!/"(name|tool)"\s*:/.test(text)) return []
	const byLower = new Map(toolNames.map((n) => [n.toLowerCase(), n]))

	// Prefer fenced/tagged regions (```json … ``` / <tool_call> … </tool_call>) — that's where models put
	// calls deliberately; fall back to the whole text when no region matches.
	const regions: string[] = []
	for (const m of text.matchAll(/```(?:json|javascript|js|tool_code)?\s*([\s\S]*?)(?:```|$)/g)) regions.push(m[1]!)
	for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g)) regions.push(m[1]!)
	const haystacks = regions.length ? regions : [text]

	const calls: ProseToolCall[] = []
	for (const region of haystacks) {
		// Whole-region array form ([ {...}, {...} ]) is parsed as an array ONLY — running the object scanner
		// too would harvest the same elements twice (caught by the unit test).
		const trimmed = region.trim()
		if (trimmed.startsWith('[')) {
			try {
				const arr = JSON.parse(trimmed)
				if (Array.isArray(arr)) {
					for (const el of arr) {
						const call = asToolCall(el, byLower)
						if (call) calls.push(call)
					}
					continue
				}
			} catch {
				/* not a clean array — fall through to the object scan */
			}
		}
		for (const raw of scanJsonObjects(region)) {
			let parsed: unknown
			try {
				parsed = JSON.parse(raw)
			} catch {
				continue // truncated/malformed candidate — skip, keep scanning
			}
			const call = asToolCall(parsed, byLower)
			if (call) calls.push(call)
		}
	}
	return calls
}
