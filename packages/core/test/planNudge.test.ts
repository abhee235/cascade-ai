// ADR-056 rung 2 — plan-first detect→remind, through the real loop. Measured motivation (skills-2): the
// composite prompt rule produced ZERO planner spawns; the harness now detects writes-without-plan and
// injects the exact call. Activation is declared by the CAPABILITY ITSELF (`proactive: true` in the
// planner def's frontmatter), never by a session flag; bare presence = available, not enforced.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentLoop, type LoopDeps } from '../src/agent/agentLoop'
import { loadAgentDefs } from '../src/agent/agentDefs'
import type { Message } from '../src/protocol'
import { createFakeProvider, textDelta, toolUse, done, type FakeProvider } from './fakeProvider'

const AGENTS = mkdtempSync(join(tmpdir(), 'plannudge-agents-'))
writeFileSync(join(AGENTS, 'planner.md'), `---\nname: planner\ndescription: Plans first.\ntools: Read, Write\nproactive: true\n---\nYou are the planner.`)
const DEFS = loadAgentDefs([AGENTS])
// Same persona WITHOUT the frontmatter opt-in — a user shadowing planner.md to keep it on-demand only.
const PASSIVE = mkdtempSync(join(tmpdir(), 'plannudge-passive-'))
writeFileSync(join(PASSIVE, 'planner.md'), `---\nname: planner\ndescription: Plans on request.\ntools: Read, Write\n---\nYou are the planner.`)
const PASSIVE_DEFS = loadAgentDefs([PASSIVE])

const deps = (provider: FakeProvider, cwd: string, over: Partial<LoopDeps> = {}): LoopDeps => ({
	provider,
	model: 'fake',
	cwd,
	signal: new AbortController().signal,
	agentDefs: DEFS,
	verifyGate: false,
	...over,
})

const writeTurn = () => [toolUse('w1', 'Write', { file_path: 'src/App.tsx', content: 'x' }), done('tool_use')] as const

describe('plan nudge (ADR-056 rung 2) — through the real loop', () => {
	it('fires ONCE when writes begin with a planner mounted and no PLAN.md', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'plannudge-'))
		const provider = createFakeProvider([
			[...writeTurn()],
			[toolUse('w2', 'Write', { file_path: 'src/B.tsx', content: 'y' }), done('tool_use')], // still no planner — must NOT re-nudge
			[textDelta('done'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build the app' }]
		await (async () => {
			for await (const _ of runAgentLoop(messages, deps(provider, cwd))) {
				/* drain */
			}
		})()
		const history = JSON.stringify(messages)
		expect(history).toContain('Subagent {agent: \\"planner\\"') // the EXACT call, injected
		expect(history.split('building without a plan').length - 1).toBe(1) // once per submit
		rmSync(cwd, { recursive: true, force: true })
	})

	it('suppressed when PLAN.md already exists', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'plannudge-'))
		writeFileSync(join(cwd, 'PLAN.md'), '# plan')
		const provider = createFakeProvider([[...writeTurn()], [textDelta('done'), done('end_turn')]])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd))) {
			/* drain */
		}
		expect(JSON.stringify(messages)).not.toContain('building without a plan')
		rmSync(cwd, { recursive: true, force: true })
	})

	it('suppressed once the planner was actually spawned', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'plannudge-'))
		const provider = createFakeProvider([
			[toolUse('s1', 'Subagent', { description: 'plan', prompt: 'plan it', agent: 'planner' }), done('tool_use')],
			[textDelta('PLAN SUMMARY'), done('end_turn')], // the CHILD planner's stream
			[...writeTurn()], // parent builds after planning — must NOT nudge
			[textDelta('done'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd))) {
			/* drain */
		}
		expect(JSON.stringify(messages)).not.toContain('building without a plan')
		rmSync(cwd, { recursive: true, force: true })
	})

	it('never fires without a planner def mounted', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'plannudge-'))
		const provider = createFakeProvider([[...writeTurn()], [textDelta('done'), done('end_turn')]])
		const messages: Message[] = [{ role: 'user', content: 'edit one file' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd, { agentDefs: [] }))) {
			/* drain */
		}
		expect(JSON.stringify(messages)).not.toContain('building without a plan')
		rmSync(cwd, { recursive: true, force: true })
	})

	it('suppressed for a PASSIVE planner (mounted but no proactive: true — presence ≠ policy)', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'plannudge-'))
		const provider = createFakeProvider([[...writeTurn()], [textDelta('done'), done('end_turn')]])
		const messages: Message[] = [{ role: 'user', content: 'build' }]
		for await (const _ of runAgentLoop(messages, deps(provider, cwd, { agentDefs: PASSIVE_DEFS }))) {
			/* drain */
		}
		expect(JSON.stringify(messages)).not.toContain('building without a plan')
		rmSync(cwd, { recursive: true, force: true })
	})
})
