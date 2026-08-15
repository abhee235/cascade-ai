// ADR-049 — the verification gate, tested through the REAL loop + real Write tool.
// The measured motivation: false_done dominated both curve ends (3B 7/10; both 35B polyglot fails).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentLoop, type LoopDeps } from '../src/agent/agentLoop'
import { z } from 'zod'
import { createRegistry, registryOf } from '../src/tools/toolRegistry'
import { STALLED_AUDIT_TURNS, foldVerifyState, isFilteredVerify, isVerifyCommand, resolveCheckCommand } from '../src/agent/verifyGate'
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

describe('verify gate hardening (ADR-051) — evidence-driven, inert for chat', () => {
	it('DECLARED check + skipped verification: directive nudge names the command, TWO strikes, then accepts', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'x' }), done('tool_use')],
			[textDelta('Done!'), done('end_turn')], // strike 1
			[textDelta('Really done!'), done('end_turn')], // strike 2 (weak models ignore single nudges — measured)
			[textDelta('I cannot run tests here.'), done('end_turn')], // accepted after the budget
		])
		const messages: Message[] = [{ role: 'user', content: 'do the task' }]
		await drain(runAgentLoop(messages, deps(provider, { check: { command: 'node --test', declared: true } })))
		expect(provider.calls.length).toBe(4)
		expect(historyText(messages)).toContain('Run `node --test` with the Bash tool NOW') // directive, not abstraction
		expect(historyText(messages)).toContain('ORIGINAL task') // re-anchored (the item-4 lesson)
	})

	it('DECLARED check holds even NO-EDIT terminals to it (eval/builder declared done-means-check-passes)', async () => {
		const provider = createFakeProvider([
			[textDelta('Everything looks correct already.'), done('end_turn')], // no edits, no check → gate objects
			[toolUse('b1', 'Bash', { command: 'node --test' }), done('tool_use')], // the nudge works: check runs
			[textDelta('Tests pass; nothing to change.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'fix the bug if any' }]
		await drain(runAgentLoop(messages, deps(provider, { check: { command: 'node --test', declared: true } })))
		expect(historyText(messages)).toContain('without having changed any files')
		expect(provider.calls.length).toBe(3)
	})

	it('resolved-but-not-declared (package.json): no-edit Q&A untouched; edit-nudge names the command but stays ONE strike', async () => {
		const check = { command: 'npm test', declared: false }
		// Q&A: must not fire at all — chat over a repo with tests is still chat (no-overfitting rule).
		const qa = createFakeProvider([[textDelta('Paris.'), done('end_turn')]])
		const qaMsgs: Message[] = [{ role: 'user', content: 'capital of France?' }]
		await drain(runAgentLoop(qaMsgs, deps(qa, { check })))
		expect(qa.calls.length).toBe(1)
		// Edits: fires as ADR-049 (once), but the TEXT now names the resolved command.
		const ed = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'x' }), done('tool_use')],
			[textDelta('Done!'), done('end_turn')], // strike 1 (and only)
			[textDelta('No tests needed.'), done('end_turn')], // accepted — strikes stay 1 without declaration
		])
		const edMsgs: Message[] = [{ role: 'user', content: 'write it' }]
		await drain(runAgentLoop(edMsgs, deps(ed, { check })))
		expect(ed.calls.length).toBe(3)
		expect(historyText(edMsgs)).toContain('Run `npm test` with the Bash tool NOW')
	})

	it('a strong model that runs the check unprompted never sees the gate (declared or not)', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'x' }), done('tool_use')],
			[toolUse('b1', 'Bash', { command: 'npm test' }), done('tool_use')],
			[textDelta('Done, verified.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'task' }]
		await drain(runAgentLoop(messages, deps(provider, { check: { command: 'npm test', declared: true } })))
		expect(provider.calls.length).toBe(3) // zero added turns — the gate is inert when behavior is already right
		expect(historyText(messages)).not.toContain('system-reminder>You')
	})

	it('running the DECLARED check counts as verifying even when it matches no generic runner name', async () => {
		// Measured (shop-forensics-1): check = `npm run build`; the model ran it UNPROMPTED at turn 2, and the
		// gate still fired twice — its detector only knew test-runner names, not the session's own command.
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'src/App.tsx', content: 'x' }), done('tool_use')],
			[toolUse('b1', 'Bash', { command: 'npm run build 2>&1' }), done('tool_use')], // the declared check, unprompted
			[textDelta('Build passes. Done.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build the shop' }]
		await drain(runAgentLoop(messages, deps(provider, { check: { command: 'npm run build', declared: true } })))
		expect(provider.calls.length).toBe(3) // no redundant nudge turns
		expect(historyText(messages)).not.toContain('system-reminder>You')
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

	it('isFilteredVerify: lossy pipes and `||` fallbacks are filtered; plain runs, 2>&1 and && are honest', () => {
		// The measured lie (dokar-9B): tsc errors start with `src/…`, so `findstr "^error"` matched nothing
		// and `|| echo BUILD PASSED` exited 0 on a broken build. None of these may count as verification.
		const bash = (command: string) => ({ id: 'x', name: 'Bash', input: { command } })
		expect(isFilteredVerify(bash('call npm run build 2>&1 | findstr /i "^error" || echo BUILD PASSED'))).toBe(true)
		expect(isFilteredVerify(bash('npm test 2>&1 | grep -i fail'))).toBe(true)
		expect(isFilteredVerify(bash('npm run build 2>&1 | Select-String "error"'))).toBe(true)
		expect(isFilteredVerify(bash('npm test || true'))).toBe(true)
		// head/tail show a truthful PREFIX (errors still reach the model) and are a habitual strong-model
		// idiom — measured on the first bench run: classifying them as filters bought two pointless nudges.
		expect(isFilteredVerify(bash('npm run build 2>&1 | tail -20'))).toBe(false)
		expect(isFilteredVerify(bash('npm run build 2>&1 | head -50'))).toBe(false)
		expect(isFilteredVerify(bash('npm run build 2>&1'))).toBe(false)
		expect(isFilteredVerify(bash('npm run build && npm test'))).toBe(false)
	})

	it('a FILTERED check clears nothing: foldVerifyState keeps the gate armed', () => {
		const filtered = { id: 't', name: 'Bash', input: { command: 'npm test 2>&1 | grep fail || echo PASSED' } }
		const r = [{ type: 'tool_result' as const, tool_use_id: 't', content: 'PASSED' }]
		expect(foldVerifyState(true, [filtered], r)).toBe(true) // still unverified — the model saw a filter, not the truth
		const honest = { id: 't', name: 'Bash', input: { command: 'npm test 2>&1' } }
		expect(foldVerifyState(true, [honest], r)).toBe(false)
	})

	it('through the loop: edit + filtered check → the verify nudge STILL fires', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'hello' }), done('tool_use')],
			[toolUse('b1', 'Bash', { command: 'node --test 2>&1 | grep -c fail || echo PASSED' }), done('tool_use')],
			[textDelta('Done, checks pass!'), done('end_turn')], // gate must refuse — the "check" was filtered
			[textDelta('Ran the real check now.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'write + fake-verify' }]
		await drain(runAgentLoop(messages, deps(provider)))
		expect(provider.calls.length).toBe(4) // the nudge bought exactly one extra turn
		expect(historyText(messages)).toContain('never ran any verification')
	})

	it('resolveCheckCommand: real test script → npm test; npm placeholder or no package.json → undefined', () => {
		const { writeFileSync } = require('node:fs') as typeof import('node:fs')
		const withTest = mkdtempSync(join(tmpdir(), 'vres-'))
		writeFileSync(join(withTest, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
		expect(resolveCheckCommand(withTest)).toBe('npm test')
		const placeholder = mkdtempSync(join(tmpdir(), 'vres-'))
		writeFileSync(join(placeholder, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
		expect(resolveCheckCommand(placeholder)).toBeUndefined()
		expect(resolveCheckCommand(mkdtempSync(join(tmpdir(), 'vres-')))).toBeUndefined() // no package.json
	})
})

describe('run-before-done gate (design-overhaul P1, generalized) — the contract rides the TOOL', () => {
	// A minimal registry tool that declares mustRunBeforeDone — how a frontend gates ANY tool with zero
	// core edits and zero session options (the reviewed per-tool name-knob alternative did not scale).
	const auditFake = {
		name: 'TemplateAudit',
		description: 'fake audit',
		inputSchema: z.object({}),
		activitySummary: () => 'auditing',
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		mustRunBeforeDone: true,
		call: async () => ({ content: 'HARD residue (1) — fix it', isError: true }),
	} as unknown as import('../src/tools/Tool').Tool
	const withAudit = () => registryOf(() => [...createRegistry().list(), auditFake])

	it('foldRunBeforeDone: no declarers ⇒ always clean; edits re-arm ALL declarers; any call clears its name (even a red one)', async () => {
		const { foldRunBeforeDone } = await import('../src/agent/verifyGate')
		const write = { id: 'w', name: 'Write', input: {} }
		const ok = [{ type: 'tool_result' as const, tool_use_id: 'w', content: 'ok' }]
		expect(foldRunBeforeDone(new Set(), [], [write], ok).size).toBe(0) // nothing declared ⇒ inert
		const armed = foldRunBeforeDone(new Set(), ['TemplateAudit'], [write], ok)
		expect([...armed]).toEqual(['TemplateAudit'])
		const failedWrite = [{ type: 'tool_result' as const, tool_use_id: 'w', content: 'no', isError: true }]
		expect(foldRunBeforeDone(new Set(), ['TemplateAudit'], [write], failedWrite).size).toBe(0) // failed edit ⇒ nothing to audit
		const audit = { id: 'a', name: 'TemplateAudit', input: {} }
		const red = [{ type: 'tool_result' as const, tool_use_id: 'a', content: 'HARD residue', isError: true }]
		expect(foldRunBeforeDone(armed, ['TemplateAudit'], [audit], red).size).toBe(0) // a RED audit still counts — its report drives the next edit
	})

	it('through the loop: unaudited terminal → ONE nudge naming the tool, then accepted', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'hi' }), done('tool_use')],
			[toolUse('b1', 'Bash', { command: 'node --test' }), done('tool_use')], // verify gate satisfied — isolates this gate
			[textDelta('Done!'), done('end_turn')], // terminal: audit pending → nudge
			[textDelta('Still done.'), done('end_turn')], // second terminal accepted (one-nudge budget)
		])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		await drain(runAgentLoop(messages, deps(provider, { registry: withAudit() })))
		expect(provider.calls.length).toBe(4)
		expect(historyText(messages)).toContain('never called the TemplateAudit tool')
	})

	it('MID-FLIGHT: edits for N turns without the declared tool ⇒ nudged BEFORE the terminal', async () => {
		// Measured (qwen3.5:9b, 2026-08-15): three of four category builds wrote their components and never
		// rewired src/App.tsx, so the "finished" app rendered the starter scaffold — and TemplateAudit was
		// called ZERO times in every one, because the run died on budget instead of stopping. A gate you only
		// reach by finishing cannot help a model that never finishes.
		const turns = STALLED_AUDIT_TURNS + 2
		const provider = createFakeProvider([
			[toolUse('w0', 'Write', { file_path: 'a.tsx', content: 'x' }), done('tool_use')],
			[toolUse('b0', 'Bash', { command: 'node --test' }), done('tool_use')], // verify gate satisfied — isolates THIS nudge
			...Array.from({ length: turns }, (_, i) => [toolUse(`w${i + 1}`, 'Write', { file_path: `c${i}.tsx`, content: 'x' }), done('tool_use')] as const),
			[textDelta('Done.'), done('end_turn')],
			[textDelta('Done.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		await drain(runAgentLoop(messages, deps(provider, { registry: withAudit() })))
		const text = historyText(messages)
		expect(text).toContain(`editing for ${STALLED_AUDIT_TURNS} turns without calling TemplateAudit`)
		// It must name the failure the model cannot see: a green build is not a rendering app.
		expect(text).toContain('not reachable yet')
		// ONCE per submit — a reminder repeated every turn becomes noise the model learns to skip.
		expect(text.split('editing for').length - 1).toBe(1)
	})

	it('MID-FLIGHT: calling the tool keeps it quiet — the nudge answers a real state, not a turn count', async () => {
		const provider = createFakeProvider([
			[toolUse('w0', 'Write', { file_path: 'a.tsx', content: 'x' }), done('tool_use')],
			[toolUse('b0', 'Bash', { command: 'node --test' }), done('tool_use')],
			// Audits as it goes, so the pending set keeps clearing and the counter never reaches the threshold.
			...Array.from({ length: STALLED_AUDIT_TURNS + 2 }, (_, i) =>
				i % 2 === 0
					? ([toolUse(`w${i + 1}`, 'Write', { file_path: `c${i}.tsx`, content: 'x' }), done('tool_use')] as const)
					: ([toolUse(`a${i + 1}`, 'TemplateAudit', {}), done('tool_use')] as const),
			),
			[textDelta('Done.'), done('end_turn')],
			[textDelta('Done.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		await drain(runAgentLoop(messages, deps(provider, { registry: withAudit() })))
		expect(historyText(messages)).not.toContain('turns without calling')
	})

	it('through the loop: running the declared tool before the terminal ⇒ no nudge', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'hi' }), done('tool_use')],
			[toolUse('b1', 'Bash', { command: 'node --test' }), done('tool_use')],
			[toolUse('a1', 'TemplateAudit', {}), done('tool_use')], // the audit runs (red — still counts)
			[textDelta('Done!'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		await drain(runAgentLoop(messages, deps(provider, { registry: withAudit() })))
		expect(provider.calls.length).toBe(4)
		expect(historyText(messages)).not.toContain('never called the TemplateAudit tool')
	})

	it('no declarer in the registry ⇒ byte-identical behavior (no nudge ever)', async () => {
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'out.txt', content: 'hi' }), done('tool_use')],
			[toolUse('b1', 'Bash', { command: 'node --test' }), done('tool_use')],
			[textDelta('Done!'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		await drain(runAgentLoop(messages, deps(provider)))
		expect(provider.calls.length).toBe(3)
		expect(historyText(messages)).not.toContain('never called the')
	})
})

describe('Stop hook (ADR-036 extension) — the user\'s own terminal policy, no core flag required', () => {
	it('a hook exiting 2 blocks ONE terminal with its stderr as the reason; the next terminal is accepted', async () => {
		const provider = createFakeProvider([
			[textDelta('Done.'), done('end_turn')], // terminal 1: hook blocks
			[textDelta('Addressed; done.'), done('end_turn')], // terminal 2: accepted (one evaluation per submit)
		])
		const hooks = { Stop: [{ hooks: [{ type: 'command' as const, command: `node -e "console.error('finish the CHANGELOG first'); process.exit(2)"` }] }] }
		const messages: Message[] = [{ role: 'user', content: 'wrap up' }]
		await drain(runAgentLoop(messages, deps(provider, { hooks: hooks as never })))
		expect(provider.calls.length).toBe(2)
		expect(historyText(messages)).toContain('finish the CHANGELOG first')
	})

	it('a hook exiting 0 does not block, and is not re-asked', async () => {
		const provider = createFakeProvider([[textDelta('Done.'), done('end_turn')]])
		const hooks = { Stop: [{ hooks: [{ type: 'command' as const, command: 'node -e "process.exit(0)"' }] }] }
		const messages: Message[] = [{ role: 'user', content: 'wrap up' }]
		await drain(runAgentLoop(messages, deps(provider, { hooks: hooks as never })))
		expect(provider.calls.length).toBe(1)
	})
})
