// ADR-036 — project hooks, tested with REAL spawned guard scripts through the REAL scheduler.
// The property under test: a user's deterministic rule holds regardless of what the model asked for.

import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHooksConfig, matchesHook, runHooks, type HooksConfig } from '../src/hooks/hookRunner'
import { scheduleTools } from '../src/tools/scheduler'
import { createRegistry } from '../src/tools/toolRegistry'
import type { ToolContext } from '../src/tools/Tool'
import type { ActivityEvent, ContentBlock } from '../src/protocol'

/** Write a guard script to disk; returns the hook command that runs it. */
function guard(dir: string, name: string, source: string): string {
	const p = join(dir, name)
	writeFileSync(p, source)
	return `node "${p}"`
}

async function drainSched(gen: AsyncGenerator<ActivityEvent, ContentBlock[]>): Promise<{ events: ActivityEvent[]; results: ContentBlock[] }> {
	const events: ActivityEvent[] = []
	let r = await gen.next()
	while (!r.done) {
		events.push(r.value)
		r = await gen.next()
	}
	return { events, results: r.value }
}

const project = () => mkdtempSync(join(tmpdir(), 'hooks-'))

describe('hookRunner — config + matcher', () => {
	it('loadHooksConfig: absent → null; malformed → null; valid → parsed', () => {
		const dir = project()
		expect(loadHooksConfig(dir)).toBeNull()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		writeFileSync(join(dir, '.cascade', 'hooks.json'), 'not json')
		expect(loadHooksConfig(dir)).toBeNull()
		writeFileSync(join(dir, '.cascade', 'hooks.json'), JSON.stringify({ PreToolUse: [{ matcher: 'Write', hooks: [{ command: 'x' }] }] }))
		expect(loadHooksConfig(dir)?.PreToolUse?.[0]?.matcher).toBe('Write')
	})

	it('matchesHook: matcher semantics (*/empty, exact, pipe list, regex, invalid regex)', () => {
		expect(matchesHook('Write')).toBe(true)
		expect(matchesHook('Write', '*')).toBe(true)
		expect(matchesHook('Write', 'Write')).toBe(true)
		expect(matchesHook('Write', 'Edit')).toBe(false)
		expect(matchesHook('Edit', 'Write|Edit')).toBe(true)
		expect(matchesHook('Bash', '^(Write|Edit)$')).toBe(false)
		expect(matchesHook('Write', '^Wri.*')).toBe(true)
		expect(matchesHook('Write', '[invalid(')).toBe(false)
	})
})

describe('hookRunner — the hook wire protocol', () => {
	it('exit 2 = deny, stderr is the model-visible reason; stdin carries the tool payload', async () => {
		const dir = project()
		const cmd = guard(dir, 'deny-env.mjs', `
			let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
				const input = JSON.parse(d);
				if (input.tool_name === 'Write' && String(input.tool_input.file_path).includes('.env')) {
					console.error('Editing .env is forbidden by project policy.');
					process.exit(2);
				}
				process.exit(0);
			});`)
		const config: HooksConfig = { PreToolUse: [{ matcher: 'Write', hooks: [{ command: cmd }] }] }
		const denied = await runHooks({ event: 'PreToolUse', config, cwd: dir, toolName: 'Write', toolInput: { file_path: '.env', content: 'x' } })
		expect(denied.decision).toBe('deny')
		expect(denied.reason).toContain('forbidden by project policy')
		const fine = await runHooks({ event: 'PreToolUse', config, cwd: dir, toolName: 'Write', toolInput: { file_path: 'ok.txt', content: 'x' } })
		expect(fine.decision).toBeUndefined()
	})

	it('stdout JSON permissionDecision allow/ask; deny wins the aggregate', async () => {
		const dir = project()
		const allow = guard(dir, 'allow.mjs', `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`)
		const deny = guard(dir, 'deny.mjs', `console.error('nope'); process.exit(2);`)
		const both: HooksConfig = { PreToolUse: [{ hooks: [{ command: allow }, { command: deny }] }] }
		const agg = await runHooks({ event: 'PreToolUse', config: both, cwd: dir, toolName: 'Read', toolInput: {} })
		expect(agg.decision).toBe('deny') // deny outranks allow
		const askCmd = guard(dir, 'ask.mjs', `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'confirm'}}));`)
		const asked = await runHooks({ event: 'PreToolUse', config: { PreToolUse: [{ hooks: [{ command: askCmd }] }] }, cwd: dir, toolName: 'Read', toolInput: {} })
		expect(asked.decision).toBe('ask')
	})

	it('fail-open: crash / plain stdout / timeout are NO opinion', async () => {
		const dir = project()
		const crash = guard(dir, 'crash.mjs', `process.exit(1);`)
		const chatty = guard(dir, 'chatty.mjs', `console.log('just logging'); process.exit(0);`)
		const hang = guard(dir, 'hang.mjs', `setTimeout(()=>{}, 60_000);`)
		const config: HooksConfig = { PreToolUse: [{ hooks: [{ command: crash }, { command: chatty }, { command: hang, timeout: 1 }] }] }
		const r = await runHooks({ event: 'PreToolUse', config, cwd: dir, toolName: 'Read', toolInput: {} })
		expect(r.decision).toBeUndefined()
	}, 15_000)
})

describe('hooks through the REAL scheduler', () => {
	const baseCtx = (dir: string, hooks: HooksConfig, onAsk?: () => void): ToolContext => ({
		cwd: dir,
		abortSignal: new AbortController().signal,
		registry: createRegistry(),
		hooks,
		permission: {
			state: { mode: 'default', allow: new Set(), deny: new Set() },
			request: () => {
				onAsk?.()
				return Promise.resolve('allow')
			},
		},
	})

	it('PreToolUse deny: tool NOT executed, model sees the hook reason', async () => {
		const dir = project()
		const cmd = guard(dir, 'deny-all-writes.mjs', `console.error('writes are frozen today'); process.exit(2);`)
		const ctx = baseCtx(dir, { PreToolUse: [{ matcher: 'Write', hooks: [{ command: cmd }] }] })
		const { results } = await drainSched(scheduleTools([{ id: 'w1', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } }], ctx))
		expect(results[0]!.type === 'tool_result' && results[0]!.isError).toBe(true)
		expect(results[0]!.type === 'tool_result' && results[0]!.content).toContain('writes are frozen today')
		expect(existsSync(join(dir, 'a.txt'))).toBe(false) // the guard actually guarded
	})

	it('PreToolUse allow: skips the permission prompt entirely', async () => {
		const dir = project()
		const cmd = guard(dir, 'allow-writes.mjs', `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`)
		let promptShown = false
		const ctx = baseCtx(dir, { PreToolUse: [{ matcher: 'Write', hooks: [{ command: cmd }] }] }, () => (promptShown = true))
		const { results } = await drainSched(scheduleTools([{ id: 'w1', name: 'Write', input: { file_path: 'b.txt', content: 'hi' } }], ctx))
		expect(results[0]!.type === 'tool_result' && results[0]!.isError).toBeFalsy()
		expect(promptShown).toBe(false) // 'default' mode would normally ask for a Write — the hook pre-approved
		expect(existsSync(join(dir, 'b.txt'))).toBe(true)
	})

	it('PostToolUse exit-2 feedback is appended to the tool_result (model-visible)', async () => {
		const dir = project()
		writeFileSync(join(dir, 'read-me.txt'), 'content')
		const cmd = guard(dir, 'lint.mjs', `console.error('lint: trailing whitespace in read-me.txt'); process.exit(2);`)
		const ctx = baseCtx(dir, { PostToolUse: [{ matcher: 'Read', hooks: [{ command: cmd }] }] })
		const { results } = await drainSched(scheduleTools([{ id: 'r1', name: 'Read', input: { file_path: 'read-me.txt' } }], ctx))
		expect(results[0]!.type === 'tool_result' && results[0]!.content).toContain('[Project hook feedback — address this]: lint: trailing whitespace')
	})
})
