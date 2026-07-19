// ADR-058 — the READ-LOOP breaker + the mid-flight check nudge, through the real loop. Measured motivation
// (Simmer live-lock, 2026-07-19): 53 turns, the same 3 files re-read 5× each, zero Edits, `npm run build`
// never run — compaction masked each read before the model acted, and the terminal gates never fire while
// tools keep being called. These tests drive the two mid-flight detectors that break that orbit.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentLoop, type LoopDeps } from '../src/agent/agentLoop'
import { foldReadLoop, READ_LOOP_THRESHOLD } from '../src/agent/readLoopGate'
import type { ContentBlock, Message } from '../src/protocol'
import type { ToolUse } from '../src/tools/runTool'
import { createFakeProvider, textDelta, toolUse, done, type FakeProvider } from './fakeProvider'

const deps = (provider: FakeProvider, cwd: string, over: Partial<LoopDeps> = {}): LoopDeps => ({
	provider,
	model: 'fake',
	cwd,
	signal: new AbortController().signal,
	...over,
})

const ok = (id: string): ContentBlock => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })
const read = (id: string, path: string, extra: Record<string, unknown> = {}): ToolUse => ({ id, name: 'Read', input: { file_path: path, ...extra } })

describe('foldReadLoop — unit', () => {
	it('counts same-file reads and reports the threshold crossing exactly once', () => {
		const counts = new Map<string, number>()
		expect(foldReadLoop(counts, [read('1', 'a.ts')], [ok('1')])).toEqual([])
		expect(foldReadLoop(counts, [read('2', 'a.ts')], [ok('2')])).toEqual([])
		expect(foldReadLoop(counts, [read('3', 'a.ts')], [ok('3')])).toEqual(['a.ts'])
		expect(foldReadLoop(counts, [read('4', 'a.ts')], [ok('4')])).toEqual([]) // 4th read: already fired, no re-fire
	})

	it('a successful Write/Edit of the file RESETS its counter (the read was consumed)', () => {
		const counts = new Map<string, number>()
		foldReadLoop(counts, [read('1', 'a.ts'), read('2', 'a.ts')], [ok('1'), ok('2')])
		foldReadLoop(counts, [{ id: 'w', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }], [ok('w')])
		expect(foldReadLoop(counts, [read('3', 'a.ts'), read('4', 'a.ts')], [ok('3'), ok('4')])).toEqual([]) // back to 2 — no fire
	})

	it('failed reads and failed writes do not move the counters', () => {
		const counts = new Map<string, number>()
		const err: ContentBlock = { type: 'tool_result', tool_use_id: 'e', content: 'no such file', isError: true }
		foldReadLoop(counts, [read('e', 'a.ts')], [err])
		expect(counts.size).toBe(0)
	})

	it('paged reads (offset/limit) count per page — walking a big file in chunks never fires', () => {
		const counts = new Map<string, number>()
		const crossings = [
			...foldReadLoop(counts, [read('1', 'big.ts', { offset: 1, limit: 100 })], [ok('1')]),
			...foldReadLoop(counts, [read('2', 'big.ts', { offset: 101, limit: 100 })], [ok('2')]),
			...foldReadLoop(counts, [read('3', 'big.ts', { offset: 201, limit: 100 })], [ok('3')]),
		]
		expect(crossings).toEqual([])
		// …but re-reading the SAME page three times is a loop like any other.
		foldReadLoop(counts, [read('4', 'big.ts', { offset: 1, limit: 100 })], [ok('4')])
		expect(foldReadLoop(counts, [read('5', 'big.ts', { offset: 1, limit: 100 })], [ok('5')])).toEqual(['big.ts'])
	})
})

describe('read-loop gate — through the real loop', () => {
	it(`fires ONCE after ${READ_LOOP_THRESHOLD} reads of the same file with no edit`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'readloop-'))
		writeFileSync(join(cwd, 'f.txt'), 'hello')
		const provider = createFakeProvider([
			[toolUse('r1', 'Read', { file_path: 'f.txt' }), done('tool_use')],
			[toolUse('r2', 'Read', { file_path: 'f.txt' }), done('tool_use')],
			[toolUse('r3', 'Read', { file_path: 'f.txt' }), done('tool_use')],
			[textDelta('done'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'fix f.txt' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd))) {
			/* drain */
		}
		const history = JSON.stringify(messages)
		expect(history).toContain(`read f.txt ${READ_LOOP_THRESHOLD} times without a single Write or Edit`)
		expect(history.split('You are looping').length - 1).toBe(1)
		// The nudge is in the request the model sees on the NEXT turn.
		expect(JSON.stringify(provider.calls[3]!.messages)).toContain('You are looping')
		rmSync(cwd, { recursive: true, force: true })
	})

	it('does not fire when an edit of the file lands between the reads', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'readloop-'))
		writeFileSync(join(cwd, 'f.txt'), 'hello')
		const provider = createFakeProvider([
			[toolUse('r1', 'Read', { file_path: 'f.txt' }), done('tool_use')],
			[toolUse('w1', 'Write', { file_path: 'f.txt', content: 'fixed' }), done('tool_use')],
			[toolUse('r2', 'Read', { file_path: 'f.txt' }), done('tool_use')],
			[toolUse('r3', 'Read', { file_path: 'f.txt' }), done('tool_use')],
			[textDelta('done'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'fix f.txt' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd))) {
			/* drain */
		}
		expect(JSON.stringify(messages)).not.toContain('You are looping')
		rmSync(cwd, { recursive: true, force: true })
	})
})

describe('mid-flight check nudge (stalled verify) — through the real loop', () => {
	it('after 5 consecutive unverified-edit turns, directs the model to the declared check ONCE', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'stalledverify-'))
		for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) writeFileSync(join(cwd, f), 'x')
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.ts', content: 'v1' }), done('tool_use')], // edit → unverified from here
			[toolUse('r1', 'Read', { file_path: 'a.ts' }), done('tool_use')],
			[toolUse('r2', 'Read', { file_path: 'b.ts' }), done('tool_use')],
			[toolUse('r3', 'Read', { file_path: 'c.ts' }), done('tool_use')],
			[toolUse('r4', 'Read', { file_path: 'd.ts' }), done('tool_use')], // 5th consecutive unverified turn → nudge
			[textDelta('on it'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build it' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd, { check: { command: 'npm run build', declared: true }, maxTurns: 12 }))) {
			/* drain */
		}
		const history = JSON.stringify(messages)
		expect(history).toContain('run no verification for 5 turns')
		expect(history).toContain('npm run build') // the directive NAMES the session check
		expect(history.split('run no verification for 5 turns').length - 1).toBe(1) // once per submit
		// It reached the model: the request after the 5th turn carries it.
		expect(JSON.stringify(provider.calls[5]!.messages)).toContain('run no verification for 5 turns')
		rmSync(cwd, { recursive: true, force: true })
	})

	it('stays silent when nothing was edited (read-only sessions)', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'stalledverify-'))
		for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']) writeFileSync(join(cwd, f), 'x')
		const provider = createFakeProvider([
			...['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((f, i) => [toolUse(`r${i}`, 'Read', { file_path: f }), done('tool_use' as const)]),
			[textDelta('summary'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'summarize the code' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd, { maxTurns: 12 }))) {
			/* drain */
		}
		expect(JSON.stringify(messages)).not.toContain('run no verification')
		rmSync(cwd, { recursive: true, force: true })
	})
})
