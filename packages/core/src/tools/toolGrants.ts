// tools/toolGrants.ts — argument-scoped tool grants (ADR-056 rung 4). An agent's `tools:` allowlist
// entry may be a bare name (`Write`) OR a scoped specifier (`Write(PLAN.md)`, `Bash(git:*)`), reusing
// the permission-rule grammar (permissions/rules.ts). A bare grant = the whole tool; a scoped grant =
// the tool is available but its input must match the pattern, else a teaching denial with NO execution.
//
// Motivation (planner-2/3, measured): a system-prompt persona CANNOT stop a mid-size model from building
// when it holds an unrestricted Write plus a build request — it wrote a 295-line monolith and never
// produced PLAN.md, ignoring "you write EXACTLY ONE file". Production tools (the plan modes of hosted builders,
// Chat Mode) enforce plan-vs-build by REMOVING the code-write CAPABILITY in the planning phase, not by
// prompting. This is that capability wall, made generic: any agent can be scoped to `Write(PLAN.md)`, a
// read-only reviewer, a `Bash(git:*)` helper. Enforcement lives with the capability (a wrapped tool),
// so it holds no matter what the model is told.

import { splitCommandSegments } from '../permissions/bashClassifier'
import { parseRule, ruleMatches } from '../permissions/rules'
import { displayPath, resolveInProject } from './projectPath'
import type { Tool, ToolContext, ToolResult } from './Tool'

/** Does this tool call satisfy at least one granted pattern? Bash is segment-aware (same as the
 *  permission gate): a compound command is only as trusted as its least-trusted segment, so EVERY
 *  segment must match a grant. File tools match on the input's file_path, NORMALIZED to its
 *  project-relative form first — measured (Simmer walkthrough): the planner wrote `/workspace/PLAN.md`
 *  (the legal file via its sandbox-absolute alias) and the raw string match wrongly denied it. */
function inputSatisfiesGrants(toolName: string, patterns: string[], input: unknown, ctx: ToolContext): boolean {
	const rules = patterns.map((p) => `${toolName}(${p})`)
	if (toolName === 'Bash') {
		const command = (input as { command?: string } | null)?.command
		const segments = typeof command === 'string' ? splitCommandSegments(command) : []
		return segments.length > 0 && segments.every((seg) => rules.some((r) => ruleMatches(r, toolName, seg)))
	}
	const fp = (input as { file_path?: string } | null)?.file_path
	if (typeof fp === 'string') {
		try {
			const relative = displayPath(ctx.cwd, resolveInProject(ctx.cwd, fp, ctx.sandbox?.root))
			return rules.some((r) => ruleMatches(r, toolName, { ...(input as object), file_path: relative }))
		} catch {
			return false // outside the project ⇒ no grant can apply
		}
	}
	return rules.some((r) => ruleMatches(r, toolName, input))
}

/** Group grants by tool name → the patterns granted for it. `undefined` in the list = a bare grant
 *  (whole tool, unrestricted). Multiple scoped grants for one tool are OR-ed (any match allows). */
function grantsByTool(grants: string[]): Map<string, (string | undefined)[]> {
	const m = new Map<string, (string | undefined)[]>()
	for (const g of grants) {
		const { tool, pattern } = parseRule(g)
		const list = m.get(tool) ?? []
		list.push(pattern)
		m.set(tool, list)
	}
	return m
}

/** The tool_result text for a blocked call. GENERIC (this mechanism isn't planner-specific): it names the
 *  allowed target(s) and states the limit is hard, so a weak model self-corrects toward the one legal
 *  action instead of retrying the same denied call. Role-specific guidance ("put it in the plan; the
 *  builder writes code") belongs in the agent's persona, not here. */
function grantDenial(name: string, patterns: string[], input: unknown): string {
	const tried = (input as { file_path?: string; command?: string } | null)?.file_path ?? (input as { command?: string } | null)?.command
	const allowed = patterns.map((p) => `${name}(${p})`).join(' or ')
	return `${name} is scoped in this role — allowed only: ${allowed}.${tried ? ` "${tried}" is not permitted.` : ''} This is a hard capability limit, not a preference; it will not lift. Take the allowed action instead.`
}

/** Wrap one tool so its input must satisfy `patterns` (as `Name(pattern)` rules) before `call` runs. */
function scopeTool(tool: Tool, patterns: string[]): Tool {
	return {
		...tool,
		async call(input: unknown, ctx: ToolContext, onProgress?: (chunk: string) => void): Promise<ToolResult> {
			if (inputSatisfiesGrants(tool.name, patterns, input, ctx)) return tool.call(input as never, ctx, onProgress)
			return { content: grantDenial(tool.name, patterns, input), isError: true }
		},
	}
}

/**
 * Filter `tools` to what `grants` permit, arg-scoping any tool granted ONLY with patterns.
 * - a tool with no grant → dropped (not available to this agent)
 * - a tool with a bare grant (`Write`) → passes through untouched
 * - a tool with only scoped grants (`Write(PLAN.md)`) → wrapped: input must match, else a teaching denial
 * Grants naming a tool absent from `tools` are ignored (nothing to grant).
 */
export function scopeToolsByGrants(tools: Tool[], grants: string[]): Tool[] {
	const byTool = grantsByTool(grants)
	const out: Tool[] = []
	for (const t of tools) {
		const patterns = byTool.get(t.name)
		if (!patterns) continue
		if (patterns.some((p) => p === undefined)) out.push(t) // any bare grant = unrestricted
		else out.push(scopeTool(t, patterns as string[]))
	}
	return out
}
