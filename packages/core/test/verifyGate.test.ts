// ADR-049 — the verification gate, tested through the REAL loop + real Write tool.
// The measured motivation: false_done dominated both curve ends (3B 7/10; both 35B polyglot fails).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentLoop, type LoopDeps } from '../src/agent/agentLoop'
import { foldVerifyState, isVerifyCommand } from '../src/agent/verifyGate'
import type { Message } from '../src/protocol'
import { createFakeProvider, textDelta, toolUse, done, type FakeProvider } from './fakeProvider'

const deps = (provider: FakeProvider, over: Partial<LoopDeps> = {}): LoopDeps => ({
	provider,
	model: 'fake',
	cwd: mkdtempSync(join(tmpdir(), 'vgate-')),
	signal: new AbortController().signal,
	...over,
})

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of iter) {
		/* consume */
	}
}

const historyText = (messages: Message[]): string => JSON.stringify(messages)

describe('verify gate (ADR-049) — through the real loop', () => {
	it('nudges ONCE when files were written but nothing verified, then accepts', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'hello' }), done('tool_use')], // turn 1: edit
			[textDelta('Done! I wrote the file.'), done('end_turn')], // turn 2: premature "done" → gate fires
			[textDelta('No test suite exists in this project.'), done('end_turn')], // turn 3: accepted (nudge is once)
		])
		const messages: Message[] = [{ role: 'user', content: 'write out.txt' }]
		await drain(runAgentLoop(messages, deps(provider)))
		expect(provider.calls.length).toBe(3) // the gate bought exactly one extra model turn
		expect(historyText(messages)).toContain('never ran any verification') // the nudge reached the transcript
	})

	it('no edits ⇒ no nudge (pure Q&A is untouched)', async () => {
		const provider = createFakeProvider([[textDelta('Paris.'), done('end_turn')]])
		const messages: Message[] = [{ role: 'user', content: 'capital of France?' }]
		await drain(runAgentLoop(messages, deps(provider)))
		expect(provider.calls.length).toBe(1)
		expect(historyText(messages)).not.toContain('never ran any verification')
	})

	it('edit + test run ⇒ no nudge (verification happened)', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'hello' }), done('tool_use')],
			[toolUse('b1', 'Bash', { command: 'node --test' }), done('tool_use')], // verification runs (result may be red — running counts)
			[textDelta('Done, tests ran.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'write + verify' }]
		await drain(runAgentLoop(messages, deps(provider)))
		expect(provider.calls.length).toBe(3) // no extra nudge turn
		expect(historyText(messages)).not.toContain('never ran any verification')
	})

	it('verifyGate: false opts out entirely', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'hello' }), done('tool_use')],
			[textDelta('Done.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'write it' }]
		await drain(runAgentLoop(messages, deps(provider, { verifyGate: false })))
		expect(provider.calls.length).toBe(2)
		expect(historyText(messages)).not.toContain('never ran any verification')
	})
})

describe('verify gate — pure helpers', () => {
	it('isVerifyCommand matches the runners incl. run-tests.mjs; ignores non-Bash and non-test commands', () => {
		expect(isVerifyCommand({ id: '1', name: 'Bash', input: { command: 'node --test' } })).toBe(true)
		expect(isVerifyCommand({ id: '2', name: 'Bash', input: { command: 'node run-tests.mjs' } })).toBe(true)
		expect(isVerifyCommand({ id: '3', name: 'Bash', input: { command: 'npx vitest run' } })).toBe(true)
		expect(isVerifyCommand({ id: '4', name: 'Bash', input: { command: 'ls -la' } })).toBe(false)
		expect(isVerifyCommand({ id: '5', name: 'Read', input: { file_path: 'test.js' } })).toBe(false)
	})

	it('foldVerifyState: failed writes do not arm the gate; a test run clears it', () => {
		const write = { id: 'w', name: 'Write', input: {} }
		const failedResult = [{ type: 'tool_result' as const, tool_use_id: 'w', content: 'nope', isError: true }]
		expect(foldVerifyState(false, [write], failedResult)).toBe(false) // failed edit ⇒ nothing to verify
		const okResult = [{ type: 'tool_result' as const, tool_use_id: 'w', content: 'ok' }]
		expect(foldVerifyState(false, [write], okResult)).toBe(true)
		const test = { id: 't', name: 'Bash', input: { command: 'npm test' } }
		const testResult = [{ type: 'tool_result' as const, tool_use_id: 't', content: 'FAIL', isError: true }]
		expect(foldVerifyState(true, [test], testResult)).toBe(false) // running a RED suite still counts as verifying
	})
})
