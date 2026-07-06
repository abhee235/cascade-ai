// ADR-056 — named agents: file-defined personas. The def's body becomes the CHILD's system prompt, its
// tool allowlist filters the child registry, its `skills:` are preloaded — and the parent only ever sees
// the final report.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentChildInstructions, agentsPromptSection, loadAgentDefs } from '../src/agent/agentDefs'
import { runAgentLoop } from '../src/agent/agentLoop'
import { loadSkills } from '../src/skills/skills'
import type { Message } from '../src/protocol'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'

function dirWith(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'agents-'))
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
	return dir
}

const PLANNER = `---
name: planner
description: Plans before building.
tools: Read, Write
maxTurns: 5
skills: architecture
---
You are the PLANNER. Write PLAN.md.`

describe('loadAgentDefs — loader + shadowing', () => {
	it('parses the contract (tools list, maxTurns, skills); user dir shadows base by name', () => {
		const base = dirWith({ 'planner.md': PLANNER })
		const user = dirWith({ 'planner.md': `---\nname: planner\ndescription: mine\n---\nMY PLANNER` })
		const defs = loadAgentDefs([base, user])
		expect(defs.length).toBe(1)
		expect(defs[0]!.body).toBe('MY PLANNER') // user wins
		const baseOnly = loadAgentDefs([base])
		expect(baseOnly[0]!.tools).toEqual(['Read', 'Write'])
		expect(baseOnly[0]!.maxTurns).toBe(5)
		expect(baseOnly[0]!.skills).toEqual(['architecture'])
		rmSync(base, { recursive: true, force: true })
		rmSync(user, { recursive: true, force: true })
	})

	it('prompt section advertises name — description; child instructions = body + preloaded skill bodies', () => {
		const defs = loadAgentDefs([dirWith({ 'planner.md': PLANNER })])
		expect(agentsPromptSection(defs, 'full')).toContain('planner — Plans before building.')
		const skills = loadSkills([dirWith({ 'architecture.md': `---\nname: architecture\ndescription: layout\n---\nTHE LAYOUT RULES` })])
		const child = agentChildInstructions(defs[0]!, skills)
		expect(child).toContain('You are the PLANNER.')
		expect(child).toContain('THE LAYOUT RULES') // born knowing the recipe
	})
})

describe('named spawn — through the real loop', () => {
	const defs = loadAgentDefs([dirWith({ 'planner.md': PLANNER })])

	it('child gets the persona as its system prompt and only the allowlisted tools', async () => {
		const provider = createFakeProvider([
			// Parent turn: delegate to the planner by name.
			[toolUse('a1', 'Subagent', { description: 'plan it', prompt: 'plan a shop', agent: 'planner' }), done('tool_use')],
			// Child turn (next scripted stream): answers directly.
			[textDelta('PLAN SUMMARY: five views.'), done('end_turn')],
			// Parent resumes with the report.
			[textDelta('Building per plan.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'make a shop' }]
		for await (const _ of runAgentLoop(messages, { provider, model: 'fake', cwd: tmpdir(), signal: new AbortController().signal, agentDefs: defs, verifyGate: false })) {
			/* drain */
		}
		// Call 2 is the CHILD's request: persona present, parent instructions absent, tools = allowlist only.
		const child = provider.calls[1]!
		expect(child.system).toContain('You are the PLANNER.')
		const advertised = (child.tools ?? []).map((t: { name: string }) => t.name).sort()
		expect(advertised).toEqual(['Read', 'Write'])
		expect(JSON.stringify(messages)).toContain('PLAN SUMMARY') // the report reached the parent
	})

	it('unknown agent name → self-correction error naming the available agents; nothing spawned', async () => {
		const provider = createFakeProvider([
			[toolUse('a1', 'Subagent', { description: 'x', prompt: 'y', agent: 'architect' }), done('tool_use')],
			[textDelta('ok'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'go' }]
		for await (const _ of runAgentLoop(messages, { provider, model: 'fake', cwd: tmpdir(), signal: new AbortController().signal, agentDefs: defs, verifyGate: false })) {
			/* drain */
		}
		expect(provider.calls.length).toBe(2) // no child stream was consumed
		const history = JSON.stringify(messages)
		expect(history).toContain('No agent named')
		expect(history).toContain('Available agents: planner')
	})
})
