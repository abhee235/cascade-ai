// agent/postEditCheck.ts — post-edit diagnostics (ADR-059): after a turn that successfully wrote/edited
// TS/JS files, the HARNESS runs a type check and injects the errors as a <system-reminder> — the model never
// has to ask. This is the in-IDE pattern (diagnostics are PUSHED after each edit, never pulled) rebuilt
// for our loop. Measured motivation (Simmer, both sessions): the Lsp tool existed with a diagnostics
// op and the model called it ZERO times in 90+ turns — recognition is the weak-model gap, so recognition
// moves into the harness (the detect→inject family, ADR-034/049/050/058). Both of the day's multi-turn error
// hunts (hand-typed PhotoName drift, `favorite` missing on 5 recipes) were type errors that this feedback
// would have surfaced in the SAME turn as the edit that caused them.
//
// Routing mirrors the Lsp tool: with a sandbox, `npx tsc --noEmit` runs INSIDE it (accurate — node_modules
// lives in a container volume); without one, the in-process LanguageService checks just the edited files.
// One check per BATCH, not per file — the scheduler serializes writes, so the end-of-turn state is what
// compiles or doesn't. Best-effort by design: no tsc yet (deps not installed), timeout, or a clean check all
// inject NOTHING — the reminder only ever appears when there are real errors to fix.

import type { ContentBlock } from '../protocol'
import type { ToolUse } from '../tools/runTool'
import { tsDiagnostics } from '../lsp/tsService'

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const TS_FILE = /\.(ts|tsx|js|jsx|mts|cts)$/i
// `src/App.tsx(12,7): error TS2304: Cannot find name 'x'.` — same shape checkProject.ts and the Lsp tool parse.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/
const MAX_SHOWN = 5
const CHECK_TIMEOUT_MS = 20_000

/** The minimal sandbox surface this check needs (structural subset of core's Sandbox.exec — exitCode is
 *  irrelevant here: a non-zero exit just means "there were errors", which we read from the output). */
export interface CheckSandbox {
	exec(command: string, opts?: { signal?: AbortSignal }): Promise<{ output: string }>
}

/** Project-relative paths of TS/JS files this batch successfully mutated (deduped, order kept). */
export function editedTsFiles(toolUses: ToolUse[], results: ContentBlock[]): string[] {
	const okById = new Map(results.map((r) => [r.type === 'tool_result' ? r.tool_use_id : '', r.type === 'tool_result' && !r.isError]))
	const files: string[] = []
	for (const tu of toolUses) {
		if (!MUTATING_TOOLS.has(tu.name) || !okById.get(tu.id)) continue
		const path = ((tu.input ?? {}) as { file_path?: string }).file_path
		if (typeof path === 'string' && TS_FILE.test(path) && !files.includes(path)) files.push(path)
	}
	return files
}

interface Diag {
	file: string
	line: number
	message: string
}

/** Errors first for the files just edited, then the rest — the model fixes what it just touched. */
function format(edited: string[], diags: Diag[]): string | undefined {
	if (diags.length === 0) return undefined
	const isEdited = (d: Diag) => edited.some((f) => d.file.endsWith(f.replace(/^\.\//, '')) || f.endsWith(d.file))
	const ordered = [...diags.filter(isEdited), ...diags.filter((d) => !isEdited(d))]
	const shown = ordered.slice(0, MAX_SHOWN).map((d) => `${d.file}(${d.line}): ${d.message}`)
	const more = ordered.length > shown.length ? `\n(+ ${ordered.length - shown.length} more)` : ''
	return (
		`<system-reminder>TypeScript check after your edit(s) — ${diags.length} error(s):\n${shown.join('\n')}${more}\n` +
		// "Fix ALL", not "fix the FIRST": serial fixing measured 14 check rounds in one build (2026-07-23) —
		// trivial unused-import errors survived 4 rounds each because the model obeyed "first" literally.
		// Most are mechanical; one pass per FILE drains the whole list in 1-2 rounds.
		'Fix ALL the listed errors now, batching fixes per file (one Edit per file), before writing anything else — they will fail the build exactly as listed. ' +
		'This is a background note, NOT a new request: do not reply to it — fix, then continue the task.</system-reminder>'
	)
}

/** What the check found: real errors to fix, or "the toolchain itself is missing" (deps never installed). */
export interface PostEditNote {
	text: string
	missingDeps?: boolean
}

/**
 * Run the routed type check for a batch that edited `files`. Returns the reminder, or undefined when
 * clean/unavailable. Never throws (a diagnostics failure must never break the loop).
 */
export async function postEditDiagnostics(files: string[], opts: { cwd: string; sandbox?: CheckSandbox }): Promise<PostEditNote | undefined> {
	try {
		if (opts.sandbox) {
			// Whole-project tsc in the sandbox (it has the real node_modules). NEVER `npx tsc`: without a local
			// install, npx fetches the FAKE `tsc@2.0.4` package ("This is not the tsc command you are looking
			// for") and the check silently parses nothing — measured: an entire 80-turn run with zero injections
			// while three files sat with syntax errors. The local-bin path either runs the real compiler or
			// fails with `not found`, which is itself the signal that DEPS WERE NEVER INSTALLED — the root
			// blocker of the run (every `npm run build` failed the same way) — so we say exactly that.
			// Bounded: a wedged container must not stall the loop — on timeout we skip silently.
			const ctrl = new AbortController()
			const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS)
			try {
				const { output } = await opts.sandbox.exec('node_modules/.bin/tsc --noEmit --pretty false 2>&1', { signal: ctrl.signal })
				if (/not found|No such file/i.test(output) && !output.includes('): error TS')) {
					return {
						missingDeps: true,
						text:
							'<system-reminder>The workspace has NO node_modules yet — nothing can compile, and `npm run build` will fail with "tsc: not found". ' +
							'Run `npm install` with the Bash tool NOW (give it a large timeout, e.g. 240000), then continue. ' +
							'Never use bare `npx tsc` here — without a local install it fetches a fake package. ' +
							'This is a background note, NOT a new request: do not reply to it — install, then continue the task.</system-reminder>',
					}
				}
				const diags: Diag[] = []
				for (const raw of output.split('\n')) {
					const m = TSC_LINE.exec(raw.trim())
					if (m) diags.push({ file: m[1].replace(/^\.\//, ''), line: Number(m[2]), message: m[4] })
				}
				const text = format(files, diags)
				return text ? { text } : undefined
			} finally {
				clearTimeout(timer)
			}
		}
		// Host fallback (extension / no sandbox): LanguageService, edited files only — cheap and local.
		const diags: Diag[] = []
		for (const f of files) {
			for (const d of tsDiagnostics(opts.cwd, f)) {
				if (d.severity === 'error') diags.push({ file: d.file, line: d.line, message: d.message })
			}
		}
		const text = format(files, diags)
		return text ? { text } : undefined
	} catch {
		return undefined // best-effort: never let diagnostics break the turn
	}
}
