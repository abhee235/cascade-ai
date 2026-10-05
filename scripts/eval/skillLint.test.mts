// skill-lint — the no-GPU quality loop for skill/agent authoring, pinned to the official checklist rules.
import { describe, expect, it } from 'vitest'
import { lintDoc } from './skillLint.mts'

const doc = (over: Partial<Parameters<typeof lintDoc>[0]>) => ({
	file: 'x.md',
	kind: 'skill' as const,
	meta: { name: 'design', description: 'Compose the shadcn/ui kit with tokens. Use when building any UI, styling, colors, dark mode.', whentouse: 'any UI work' },
	body: '# Design\nRules here.',
	references: [],
	...over,
})

describe('skillLint — official checklist as code', () => {
	it('a well-formed skill passes clean', () => {
		expect(lintDoc(doc({}))).toEqual([])
	})

	it('hard rules FAIL: missing name/description, >500-line body, unknown agent tool', () => {
		expect(lintDoc(doc({ meta: { description: 'long enough description with Use when routing triggers included' } })).some((f) => f.rule === 'name-required' && f.level === 'FAIL')).toBe(true)
		expect(lintDoc(doc({ meta: { name: 'design' } })).some((f) => f.rule === 'description-required' && f.level === 'FAIL')).toBe(true)
		expect(lintDoc(doc({ body: Array(501).fill('line').join('\n') })).some((f) => f.rule === 'body-length' && f.level === 'FAIL')).toBe(true)
		expect(lintDoc(doc({ kind: 'agent', meta: { ...doc({}).meta, tools: 'Read, Writ' } })).some((f) => f.rule === 'unknown-tool' && f.level === 'FAIL')).toBe(true)
	})

	it('judged rules WARN: vague description, first-person POV, missing triggers, unadvertised reference', () => {
		expect(lintDoc(doc({ meta: { name: 'design', description: 'Helps with UI' } })).some((f) => f.rule === 'description-vague')).toBe(true)
		expect(lintDoc(doc({ meta: { name: 'design', description: 'I can help you build user interfaces with the kit' } })).some((f) => f.rule === 'description-pov')).toBe(true)
		expect(lintDoc(doc({ meta: { name: 'design', description: 'Compose the shadcn/ui kit with design tokens throughout' } })).some((f) => f.rule === 'trigger-language')).toBe(true)
		expect(lintDoc(doc({ references: ['reference/components.md'] })).some((f) => f.rule === 'unadvertised-reference')).toBe(true)
	})

	it('workflow of 4+ numbered steps without a copyable checklist warns (skill rule)', () => {
		const steps = '# S\n1. a\n2. b\n3. c\n4. d\n'
		expect(lintDoc(doc({ body: steps })).some((f) => f.rule === 'no-checklist')).toBe(true)
		expect(lintDoc(doc({ body: `${steps}\n- [ ] a\n` })).some((f) => f.rule === 'no-checklist')).toBe(false)
	})
})
