// ADR-050 rung 2 — the harness-detected delegation reminder, through the REAL loop + real Read tool.
// Motivation (measured): zero Subagent calls in all eval history; recognition must live in the harness.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentLoop, type LoopDeps } from '../src/agent/agentLoop'
import { foldReadPressure, sawSubagent } from '../src/agent/delegateNudge'
import { planCompaction } from '../src/context/compactionPlan'
import type { TraceEvent, Tracer } from '../src/observability/tracer'
import type { Message } from '../src/protocol'
import { createRegistry, registryOf } from '../src/tools/toolRegistry'
import { createFakeProvider, textDelta, toolUse, done, type FakeProvider } from './fakeProvider'

function capturingTracer(): Tracer & { events: TraceEvent[] } {
	const events: TraceEvent[] = []
	return { events, event: (e) => void events.push(e) }
}

/** A temp project with one big file (≈6k chars — crosses 35% of a 2000-token window in one Read). */
function bigFileProject(): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), 'dnudge-'))
	const file = join(dir, 'big.txt')
	writeFileSync(file, 'lorem ipsum dolor sit amet '.repeat(230))
	return { dir, file }
}

const nudgeDeps = (provider: FakeProvider, dir: string, over: Partial<LoopDeps> = {}): LoopDeps => ({
	provider,
	model: 'fake',
	cwd: dir,
	signal: new AbortController().signal,
	// Small window ⇒ the single big Read crosses the 35% pressure threshold immediately.
	compact: { provider, model: 'fake', plan: planCompaction({ window: 2000 }) },
	...over,
})

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of iter) {
		/* consume */
	}
}

const historyText = (m: Message[]): string => JSON.stringify(m)

describe('delegation nudge (ADR-050 rung 2) — through the real loop', () => {
	it('fires ONCE when bulk reads cross the pressure threshold without delegation', async () => {
		const { dir, file } = bigFileProject()
		const provider = createFakeProvider([
			[toolUse('r1', 'Read', { file_path: file }), done('tool_use')],
			[toolUse('r2', 'Read', { file_path: file }), done('tool_use')], // still reading solo — must NOT re-nudge
			[textDelta('summary of the file'), done('end_turn')],
		])
		const tracer = capturingTracer()
		const messages: Message[] = [{ role: 'user', content: 'summarize the big files' }]
		await drain(runAgentLoop(messages, nudgeDeps(provider, dir, { tracer })))
		const nudges = tracer.events.filter((e) => e.t === 'delegate_nudge')
		expect(nudges.length).toBe(1) // once per submit, even with continued solo reading
		expect(historyText(messages)).toContain('use the Subagent tool instead')
	})

	it('silent when the window is unknown (no compact deps)', async () => {
		const { dir, file } = bigFileProject()
		const provider = createFakeProvider([
			[toolUse('r1', 'Read', { file_path: file }), done('tool_use')],
			[textDelta('done'), done('end_turn')],
		])
		const tracer = capturingTracer()
		const messages: Message[] = [{ role: 'user', content: 'read it' }]
		await drain(runAgentLoop(messages, nudgeDeps(provider, dir, { tracer, compact: undefined })))
		expect(tracer.events.some((e) => e.t === 'delegate_nudge')).toBe(false)
	})

	it('silent when the Subagent tool is not in the registry (child loops)', async () => {
		const { dir, file } = bigFileProject()
		const provider = createFakeProvider([
			[toolUse('r1', 'Read', { file_path: file }), done('tool_use')],
			[textDelta('done'), done('end_turn')],
		])
		const tracer = capturingTracer()
		const childRegistry = registryOf(() => createRegistry().list().filter((t) => t.name !== 'Subagent'))
		const messages: Message[] = [{ role: 'user', content: 'read it' }]
		await drain(runAgentLoop(messages, nudgeDeps(provider, dir, { tracer, registry: childRegistry })))
		expect(tracer.events.some((e) => e.t === 'delegate_nudge')).toBe(false)
	})

	it('delegateNudge: false opts out', async () => {
		const { dir, file } = bigFileProject()
		const provider = createFakeProvider([
			[toolUse('r1', 'Read', { file_path: file }), done('tool_use')],
			[textDelta('done'), done('end_turn')],
		])
		const tracer = capturingTracer()
		const messages: Message[] = [{ role: 'user', content: 'read it' }]
		await drain(runAgentLoop(messages, nudgeDeps(provider, dir, { tracer, delegateNudge: false })))
		expect(tracer.events.some((e) => e.t === 'delegate_nudge')).toBe(false)
	})
})

describe('delegation nudge — pure helpers', () => {
	it('foldReadPressure counts successful Read/Grep/Glob results only', () => {
		const uses = [
			{ id: 'r', name: 'Read', input: {} },
			{ id: 'g', name: 'Grep', input: {} },
			{ id: 'b', name: 'Bash', input: {} }, // not a bulk-read tool
			{ id: 'e', name: 'Read', input: {} }, // errored — must not count
		]
		const results = [
			{ type: 'tool_result' as const, tool_use_id: 'r', content: 'x'.repeat(400) }, // 100 tok
			{ type: 'tool_result' as const, tool_use_id: 'g', content: 'x'.repeat(200) }, // 50 tok
			{ type: 'tool_result' as const, tool_use_id: 'b', content: 'x'.repeat(4000) },
			{ type: 'tool_result' as const, tool_use_id: 'e', content: 'x'.repeat(4000), isError: true },
		]
		expect(foldReadPressure(10, uses, results)).toBe(160) // 10 + 100 + 50
	})

	it('sawSubagent detects delegation in a batch', () => {
		expect(sawSubagent([{ id: 's', name: 'Subagent', input: {} }])).toBe(true)
		expect(sawSubagent([{ id: 'r', name: 'Read', input: {} }])).toBe(false)
	})
})
