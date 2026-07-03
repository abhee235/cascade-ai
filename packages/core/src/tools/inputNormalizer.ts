// tools/inputNormalizer.ts — rescue near-miss tool inputs from weak models (ADR-048).
//
// Eval evidence (prose-fallback-3b traces): the 3B's dominant `invalid_args` mode is the RIGHT value under
// the WRONG key — Read{path:…} instead of file_path, Read{glob:…}, Write{content} missing file_path — and
// it retried the IDENTICAL wrong call 4× because our error was a raw Zod JSON dump it couldn't act on.
// Two remedies, both at the runTool seam so every builtin benefits:
//   1. normalizeInput: move known ALIAS keys onto the canonical key — conservatively (see rules below).
//   2. describeInvalidInput: a compact, DIRECTIVE error (expected keys · what you sent · what's missing)
//      instead of the Zod dump, so a weak model's retry has something to act on.

import type { ZodType } from 'zod'

/** Canonical key → alias keys weak models actually use (observed + common conventions). */
const ALIASES: Record<string, string[]> = {
	file_path: ['path', 'filepath', 'filename', 'file', 'glob'],
	pattern: ['regex', 'query', 'search'],
	command: ['cmd', 'script', 'shell'],
	old_string: ['old', 'old_text', 'oldstring', 'find'],
	new_string: ['new', 'new_text', 'newstring', 'replace', 'replacement'],
	content: ['text', 'body', 'contents', 'data'],
	todos: ['items', 'tasks', 'list'],
	prompt: ['task', 'instruction', 'query'],
}

/** Top-level keys of a Zod object schema, or null when not introspectable (e.g. wrapped in .refine()). */
export function schemaKeys(schema: ZodType): string[] | null {
	const shape = (schema as { shape?: Record<string, unknown> }).shape
	if (shape && typeof shape === 'object') return Object.keys(shape)
	// ZodEffects (.refine) wraps the object — try the inner type (zod v4: _def.schema / .innerType()).
	const inner = (schema as { _def?: { schema?: ZodType } })._def?.schema
	if (inner) return schemaKeys(inner)
	return null
}

/**
 * Move alias keys onto canonical schema keys. CONSERVATIVE by design:
 *   - only when the canonical key is MISSING from the input (never overwrite what the model said),
 *   - only when the alias is NOT itself a valid schema key (Glob's `path` is legitimate — a {path, no
 *     pattern} call must NOT have path repurposed into pattern),
 *   - case-insensitive exact key matches are folded too (File_Path → file_path).
 * Returns null when nothing changed (caller keeps the original error path).
 */
export function normalizeInput(input: unknown, schema: ZodType): Record<string, unknown> | null {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
	const keys = schemaKeys(schema)
	if (!keys) return null
	const keySet = new Set(keys)
	const lowerToCanonical = new Map(keys.map((k) => [k.toLowerCase(), k]))

	const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
	let changed = false

	// Pass 1: fold case-variant keys onto the canonical spelling.
	for (const k of Object.keys(out)) {
		if (keySet.has(k)) continue
		const canonical = lowerToCanonical.get(k.toLowerCase())
		if (canonical && !(canonical in out)) {
			out[canonical] = out[k]
			delete out[k]
			changed = true
		}
	}
	// Pass 2: known aliases → canonical, under the conservative rules.
	for (const canonical of keys) {
		if (canonical in out) continue
		for (const alias of ALIASES[canonical] ?? []) {
			if (alias in out && !keySet.has(alias)) {
				out[canonical] = out[alias]
				delete out[alias]
				changed = true
				break
			}
		}
	}
	return changed ? out : null
}

/** Compact, actionable validation error: what's expected, what was sent, what's missing/wrong. */
export function describeInvalidInput(toolName: string, input: unknown, schema: ZodType, zodMessage: string): string {
	const keys = schemaKeys(schema)
	const sent = typeof input === 'object' && input !== null ? Object.keys(input as object) : [typeof input]
	// Pull the offending paths out of the Zod error without dumping its JSON (issues → "file_path (expected string)").
	const problems: string[] = []
	try {
		for (const issue of JSON.parse(zodMessage) as { path?: (string | number)[]; expected?: string; message?: string }[]) {
			const where = issue.path?.join('.') || '(input)'
			problems.push(issue.expected ? `${where} (expected ${issue.expected})` : `${where}: ${issue.message ?? 'invalid'}`)
			if (problems.length >= 3) break
		}
	} catch {
		problems.push(zodMessage.split('\n')[0]!.slice(0, 120)) // non-JSON message — first line, capped
	}
	const expected = keys ? `Expected keys: ${keys.join(', ')}. ` : ''
	return `Invalid input for ${toolName}: ${problems.join('; ')}. ${expected}You sent: ${sent.join(', ') || '(nothing)'}. Fix the argument names/types and call ${toolName} again.`
}
