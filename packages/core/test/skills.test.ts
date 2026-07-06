// ADR-055 — the skills engine: knowledge as retrievable files. Index always visible (cheap), bodies via
// the Skill tool on demand. Base dirs first, user dirs last — user shadows base by name; base files live
// outside the project (immutable by construction, not by convention).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentLoop } from '../src/agent/agentLoop'
import { buildSystemPrompt } from '../src/agent/systemPrompt'
import { createSkillTool, loadSkills, skillsPromptSection } from '../src/skills/skills'
import { registryOf, createRegistry } from '../src/tools/toolRegistry'
import { executeTool } from '../src/tools/runTool'
import type { Message } from '../src/protocol'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'

function skillDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'skills-'))
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
	return dir
}

const FM = (name: string, desc: string, body: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`

describe('loadSkills — loader + shadowing', () => {
	it('parses frontmatter; falls back to filename + first heading without it; skips INDEX.md', () => {
		const dir = skillDir({
			'design.md': FM('design', 'Use the kit.', '# Design\nCompose shadcn.'),
			'plain.md': '# Plain skill heading\nBody here.',
			'INDEX.md': 'never load me',
		})
		const skills = loadSkills([dir])
		expect(skills.map((s) => s.name).sort()).toEqual(['design', 'plain'])
		expect(skills.find((s) => s.name === 'design')!.description).toBe('Use the kit.')
		expect(skills.find((s) => s.name === 'plain')!.description).toBe('Plain skill heading')
		expect(skills.find((s) => s.name === 'design')!.body).toContain('Compose shadcn.')
	})

	it('DIRECTORY skills: <name>/SKILL.md + bundled references, served via Skill {name, file}', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'skills-'))
		mkdirSync(join(dir, 'design', 'reference'), { recursive: true })
		writeFileSync(join(dir, 'design', 'SKILL.md'), FM('design', 'Kit rules.', 'THE TOC BODY'))
		writeFileSync(join(dir, 'design', 'reference', 'components.md'), '# Every component precisely')
		const skills = loadSkills([dir])
		expect(skills[0]!.references).toEqual({ 'reference/components.md': join(dir, 'design', 'reference', 'components.md') })
		const tool = createSkillTool(skills)
		const ctx = { cwd: tmpdir(), abortSignal: new AbortController().signal }
		const body = await tool.call({ name: 'design' }, ctx as never)
		expect(body.content).toContain('THE TOC BODY')
		expect(body.content).toContain('reference/components.md') // the footer advertises what's loadable
		const ref = await tool.call({ name: 'design', file: 'reference/components.md' }, ctx as never)
		expect(ref.content).toContain('Every component precisely')
		const miss = await tool.call({ name: 'design', file: 'reference/nope.md' }, ctx as never)
		expect(miss.isError).toBe(true)
		expect(miss.content).toContain('reference/components.md') // self-correction lists the real ones
		rmSync(dir, { recursive: true, force: true })
	})

	it('later dirs SHADOW earlier by name (user over base); missing dirs are tolerated', () => {
		const base = skillDir({ 'design.md': FM('design', 'base version', 'BASE BODY') })
		const user = skillDir({ 'design.md': FM('design', 'my version', 'USER BODY'), 'mine.md': FM('mine', 'custom', 'X') })
		const skills = loadSkills([base, user, join(tmpdir(), 'does-not-exist-xyz')])
		expect(skills.length).toBe(2)
		expect(skills.find((s) => s.name === 'design')!.body).toBe('USER BODY') // user wins
		rmSync(base, { recursive: true, force: true })
		rmSync(user, { recursive: true, force: true })
	})
})

describe('Skill tool + prompt surfacing', () => {
	const skills = loadSkills([skillDir({ 'design.md': FM('design', 'Use the kit.', 'THE DESIGN RULES'), 'data.md': FM('data', 'Catalogs.', 'THE DATA RULES') })])

	it('serves the body by name (case-insensitive); unknown name lists the available (self-correction)', async () => {
		const tool = createSkillTool(skills)
		const ctx = { cwd: tmpdir(), abortSignal: new AbortController().signal, registry: registryOf(() => [tool]) }
		const ok = await executeTool({ id: '1', name: 'Skill', input: { name: 'Design' } }, ctx)
		expect(ok.content).toContain('THE DESIGN RULES')
		const bad = await executeTool({ id: '2', name: 'Skill', input: { name: 'colors' } }, ctx)
		expect(bad.isError).toBe(true)
		expect(bad.content).toContain('data, design') // teaches the valid names
	})

	it('prompt section: one line per skill at full tier; names-only at minimal; absent when empty', () => {
		const full = skillsPromptSection(skills, 'full')
		expect(full).toContain('design — Use the kit.')
		expect(full).not.toContain('THE DESIGN RULES') // bodies NEVER inline (progressive disclosure)
		expect(skillsPromptSection(skills, 'minimal')).toBe('## Skills\nCall the Skill tool with a name BEFORE related work: data, design.')
		expect(skillsPromptSection([], 'full')).toBe('')
		const sys = buildSystemPrompt({ cwd: tmpdir(), skillsSection: full })
		expect(sys).toContain('design — Use the kit.')
	})

	it('through the REAL loop: the model Skill-calls and receives the body as a tool result', async () => {
		const tool = createSkillTool(skills)
		const provider = createFakeProvider([
			[toolUse('s1', 'Skill', { name: 'design' }), done('tool_use')],
			[textDelta('Got the rules.'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build a page' }]
		await new Promise<void>(async (resolve) => {
			for await (const _ of runAgentLoop(messages, {
				provider,
				model: 'fake',
				cwd: tmpdir(),
				signal: new AbortController().signal,
				registry: createRegistry(() => [tool]),
				skillsSection: skillsPromptSection(skills, 'full'),
			})) {
				/* drain */
			}
			resolve()
		})
		const history = JSON.stringify(messages)
		expect(history).toContain('THE DESIGN RULES') // the body arrived as the tool_result
		expect(provider.calls[0]!.system).toContain('design — Use the kit.') // and the index was advertised
	})
})
