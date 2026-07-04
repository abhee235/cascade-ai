// llm/jsonRepair.ts — parse tool-call arguments HONESTLY (item 4a, extends ADR-048).
//
// The failure this kills (measured, invalid-args/prose-fallback 3B traces): a weak model emits ALMOST-JSON
// arguments — a trailing comma, single quotes, unquoted keys, or a stream cut mid-object. The old behavior
// swallowed the parse error (`catch { input = {} }`), so the tool saw {} and the model was told
// "missing required file_path" — a LIE pointing away from the real problem (its own syntax). Two rules:
//   1. REPAIR what is mechanically repairable — a fixed ladder of pure syntax rungs, never guessing content.
//   2. When repair fails, be HONEST: carry the raw text through as { __rawArgs } so runTool can tell the
//      model exactly what it sent and that the JSON was malformed (directive error, ADR-048 style).
//
// Closing the truncated structures of a streamed partial JSON is the standard move; the sentinel-honesty
// half is the addition (frontier models rarely emit broken JSON; 3B locals do constantly).

/** Sentinel key runTool checks for: the arguments could not be parsed as JSON at all. */
export const RAW_ARGS_KEY = '__rawArgs'

export interface ParsedArgs {
	input: unknown
	/** How the args were obtained: parsed clean, syntax-repaired, or unparseable (sentinel carries the raw). */
	via: 'exact' | 'repaired' | 'raw'
}

/**
 * Parse a tool call's arguments from whatever the wire delivered: an object (Ollama native), a JSON string
 * (OpenAI-compat), or a weak model's almost-JSON. Tool arguments are ALWAYS an object, so any non-object
 * outcome is a failure → sentinel (a bare string like `"src/index.js"` must produce the honest error, not
 * a confusing schema dump).
 */
export function parseToolArgs(raw: unknown): ParsedArgs {
	if (raw === undefined || raw === null || raw === '') return { input: {}, via: 'exact' }
	if (typeof raw === 'object') return { input: raw, via: 'exact' } // native path: already parsed by the backend
	const s = String(raw).trim()
	const exact = tryParseObject(s)
	if (exact !== undefined) return { input: exact, via: 'exact' }
	const repaired = repairJson(s)
	if (repaired !== undefined) return { input: repaired, via: 'repaired' }
	return { input: { [RAW_ARGS_KEY]: s.slice(0, 2000) }, via: 'raw' }
}

/** JSON.parse that only accepts a plain object result (tool args are objects, never scalars/arrays). */
function tryParseObject(s: string): Record<string, unknown> | undefined {
	try {
		const v = JSON.parse(s)
		return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
	} catch {
		return undefined
	}
}

/**
 * The repair ladder. Rungs are applied CUMULATIVELY (each real-world payload usually needs one, but a
 * fenced + trailing-comma + truncated payload needs all three), parsing after every rung. All transforms are
 * string-aware where it matters (the truncation closer tracks quote state); the cheaper rungs use regexes
 * that are safe for the payload shapes tool args actually take.
 */
function repairJson(s: string): Record<string, unknown> | undefined {
	let cur = s

	// Rung 1 — unwrap: code fences / surrounding prose. Take first '{' … last '}' (or to end if unbalanced).
	const first = cur.indexOf('{')
	if (first === -1) return undefined // no object anywhere — nothing mechanical to do
	const last = cur.lastIndexOf('}')
	cur = last > first ? cur.slice(first, last + 1) : cur.slice(first)
	let v = tryParseObject(cur)
	if (v) return v

	// Rung 2 — trailing commas before } or ].
	cur = cur.replace(/,\s*([}\]])/g, '$1')
	v = tryParseObject(cur)
	if (v) return v

	// Rung 3 — unquoted object keys: {file_path: …} → {"file_path": …}.
	cur = cur.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
	v = tryParseObject(cur)
	if (v) return v

	// Rung 4 — single-quoted strings → double-quoted (escaping embedded double quotes). Applied only if it
	// parses — a payload where ' is legitimate content (a Bash command) either parses fine before this rung
	// or fails and falls through to the sentinel rather than shipping mangled content.
	const dq = cur.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => `"${inner.replace(/"/g, '\\"')}"`)
	v = tryParseObject(dq)
	if (v) return v

	// Rung 5 — truncation: the stream stopped mid-object (hit num_predict / connection drop). Close an open
	// string, drop a dangling partial token (`"key":` or trailing comma), then close open braces/brackets.
	v = tryParseObject(closeTruncated(cur))
	if (v) return v

	return undefined
}

/** Close a truncated JSON prefix: tracks quote/escape state, then appends the missing closers. */
function closeTruncated(s: string): string {
	const stack: string[] = []
	let inString = false
	let escaped = false
	for (const ch of s) {
		if (escaped) {
			escaped = false
			continue
		}
		if (ch === '\\') {
			escaped = true
			continue
		}
		if (inString) {
			if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === '{') stack.push('}')
		else if (ch === '[') stack.push(']')
		else if (ch === '}' || ch === ']') stack.pop()
	}
	let out = s
	if (escaped) out = out.slice(0, -1) // a lone trailing backslash can't be closed — drop it
	if (inString) out += '"'
	// A dangling `"key":` or `,` before the closers is itself invalid — trim to a fixed point (removing a
	// dangling key exposes the comma before it, which must go too).
	let prev: string
	do {
		prev = out
		out = out.replace(/("([^"\\]|\\.)*"\s*:\s*|,\s*)$/, '')
	} while (out !== prev)
	while (stack.length) out += stack.pop()
	return out
}
