// hooks/hookRunner.ts — user-owned guards around tool execution (ADR-036). The protocol: stdin JSON in;
// decisions out via exit code 2 = block-with-stderr-to-the-model, or stdout JSON permissionDecision
// allow|deny|ask.
//
// Why: every existing guard (permission gate, confinement, verify gate) is harness-internal. Hooks are the
// USER's deterministic rules — the ones a weak model can't be trusted to obey from prompt text alone
// ("never touch .env", "lint every edit"). Fail-open on hook ERRORS (a broken guard must not brick the
// agent), fail-closed only on an explicit block.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface HookCommand {
	command: string
	/** Seconds. Default 30 (deliberately NOT 10 minutes — a hung guard must not hang the agent). */
	timeout?: number
}
export interface HookMatcherEntry {
	/** '*'/empty = all tools · exact or pipe-separated names · otherwise regex. */
	matcher?: string
	hooks: HookCommand[]
}
export type HooksConfig = Partial<Record<HookEvent, HookMatcherEntry[]>>

export interface HookDecision {
	decision?: 'allow' | 'deny' | 'ask'
	/** The reason THE MODEL sees on deny (exit-2 stderr or permissionDecisionReason). */
	reason?: string
	/** PostToolUse: blocking feedback lines to append to the tool_result (model-visible). */
	feedback: string[]
}

export const HOOKS_FILE = join('.cascade', 'hooks.json')
const DEFAULT_TIMEOUT_S = 30

/** Load `.cascade/hooks.json` for a project. Absent/invalid ⇒ null (zero code path — default-off). */
export function loadHooksConfig(cwd: string): HooksConfig | null {
	const path = join(cwd, HOOKS_FILE)
	if (!existsSync(path)) return null
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as HooksConfig
		return typeof parsed === 'object' && parsed !== null ? parsed : null
	} catch {
		return null // malformed config: ignore rather than brick the session (surfaced via trace on first use)
	}
}

/** Matcher semantics: '*'/empty → all; plain/pipe names → exact; else regex. */
export function matchesHook(toolName: string, matcher?: string): boolean {
	if (!matcher || matcher === '*') return true
	if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
		return matcher.includes('|') ? matcher.split('|').map((p) => p.trim()).includes(toolName) : matcher === toolName
	}
	try {
		return new RegExp(matcher).test(toolName)
	} catch {
		return false // invalid regex: never match (logged by the caller's trace)
	}
}

interface SpawnResult {
	status: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

/** Run one hook command: shell spawn, JSON on stdin, TREE-kill on timeout.
 *  Windows lesson (learned twice now — zombie jest workers, and this test): shell:true spawns cmd.exe whose
 *  GRANDCHILD is the real process; child.kill() leaves the grandchild alive holding the stdio pipes, so
 *  'close' never fires. On timeout we taskkill the whole tree AND resolve immediately — a hung guard costs
 *  its timeout budget, never the agent's liveness. */
function runHookCommand(cmd: HookCommand, stdinJson: string, cwd: string): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd.command, { shell: true, cwd, windowsHide: true })
		let stdout = ''
		let stderr = ''
		let settled = false
		const finish = (r: SpawnResult) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(r)
		}
		const timer = setTimeout(
			() => {
				if (process.platform === 'win32' && child.pid) {
					spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
				} else {
					child.kill('SIGKILL')
				}
				finish({ status: null, stdout, stderr, timedOut: true }) // don't wait for the tree to die
			},
			(cmd.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
		)
		child.stdout.on('data', (d) => (stdout += d))
		child.stderr.on('data', (d) => (stderr += d))
		child.on('error', () => finish({ status: null, stdout, stderr, timedOut: false })) // unspawnable → no opinion
		child.on('close', (status) => finish({ status, stdout, stderr, timedOut: false }))
		child.stdin.on('error', () => {}) // guard may exit before reading stdin (EPIPE) — not our problem
		child.stdin.write(stdinJson)
		child.stdin.end()
	})
}

/** Interpret one hook result per the hook protocol. Returns a partial decision (or nothing). */
function interpret(event: HookEvent, r: SpawnResult): Partial<HookDecision> {
	if (r.timedOut || r.status === null) return {} // hung/unspawnable guard → no opinion
	// Exit 2 = explicit block; stderr is the model-visible reason.
	if (r.status === 2) {
		const reason = r.stderr.trim() || 'Blocked by a project hook (no reason given).'
		// PreToolUse: deny the call. Stop: block the terminal (the reason becomes the continue-nudge).
		return event === 'PreToolUse' || event === 'Stop' ? { decision: 'deny', reason } : { feedback: [reason] }
	}
	if (r.status !== 0) return {} // other failures are non-critical (shown to the user only)
	// Exit 0: check for the structured JSON decision on stdout (PreToolUse only).
	if (event === 'PreToolUse') {
		try {
			const json = JSON.parse(r.stdout) as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } }
			const out = json.hookSpecificOutput
			if (out?.hookEventName === 'PreToolUse' && (out.permissionDecision === 'allow' || out.permissionDecision === 'deny' || out.permissionDecision === 'ask')) {
				return { decision: out.permissionDecision, reason: out.permissionDecisionReason }
			}
		} catch {
			/* plain-text stdout — success with no opinion */
		}
	}
	return {}
}

/**
 * Run all matching hooks for an event, in parallel (Promise.all; deny wins the aggregate).
 * Aggregation: any deny → deny (first reason) · else any ask → ask · else any allow → allow · else none.
 */
export async function runHooks(opts: {
	event: HookEvent
	config: HooksConfig
	cwd: string
	sessionId?: string
	toolName: string
	toolInput: unknown
	toolResponse?: string
}): Promise<HookDecision> {
	const entries = (opts.config[opts.event] ?? []).filter((e) => matchesHook(opts.toolName, e.matcher))
	const commands = entries.flatMap((e) => e.hooks)
	const none: HookDecision = { feedback: [] }
	if (commands.length === 0) return none

	const stdinJson = JSON.stringify({
		hook_event_name: opts.event,
		tool_name: opts.toolName,
		tool_input: opts.toolInput,
		...(opts.toolResponse !== undefined ? { tool_response: opts.toolResponse } : {}),
		cwd: opts.cwd,
		session_id: opts.sessionId ?? '',
	})
	const results = await Promise.all(commands.map((c) => runHookCommand(c, stdinJson, opts.cwd)))
	const parts = results.map((r) => interpret(opts.event, r))

	const agg: HookDecision = { feedback: parts.flatMap((p) => p.feedback ?? []) }
	for (const want of ['deny', 'ask', 'allow'] as const) {
		const hit = parts.find((p) => p.decision === want)
		if (hit) {
			agg.decision = want
			agg.reason = hit.reason
			break
		}
	}
	return agg
}
