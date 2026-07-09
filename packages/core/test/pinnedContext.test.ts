// ADR-056 rung 5 — pinned context files. Measured (planner-4): the builder read PLAN.md 0 times when it
// only sat on disk (convergent architecture, not consumption). A durable contract must be AMBIENT — in the
// system prompt every turn, surviving compaction, never dependent on the model choosing to Read. Same
// pattern as memory (read fresh each call). Generic: core doesn't know PLAN.md means anything.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/agent/systemPrompt'

let dirs: string[] = []
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), 'pinned-'))
	dirs.push(d)
	return d
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true })
	dirs = []
})

describe('pinned context files (ADR-056 rung 5)', () => {
	it('injects an existing cwd-relative file under a basename header', () => {
		const cwd = tmp()
		writeFileSync(join(cwd, 'PLAN.md'), '# The Plan\n- Views: Catalog, Cart')
		const prompt = buildSystemPrompt({ cwd, contextFiles: ['PLAN.md'] })
		expect(prompt).toContain('# Pinned context (kept current every turn)')
		expect(prompt).toContain('## PLAN.md')
		expect(prompt).toContain('- Views: Catalog, Cart')
	})

	it('re-reads FRESH each call — an updated plan shows up on the next turn (like memory)', () => {
		const cwd = tmp()
		writeFileSync(join(cwd, 'PLAN.md'), 'v1 plan')
		expect(buildSystemPrompt({ cwd, contextFiles: ['PLAN.md'] })).toContain('v1 plan')
		writeFileSync(join(cwd, 'PLAN.md'), 'v2 plan') // planner updated it mid-session
		const next = buildSystemPrompt({ cwd, contextFiles: ['PLAN.md'] })
		expect(next).toContain('v2 plan')
		expect(next).not.toContain('v1 plan')
	})

	it('a missing pinned file is skipped silently (no header, no throw)', () => {
		const cwd = tmp() // no PLAN.md written
		const prompt = buildSystemPrompt({ cwd, contextFiles: ['PLAN.md'] })
		expect(prompt).not.toContain('Pinned context')
		expect(prompt).not.toContain('PLAN.md')
	})

	it('an empty pinned file contributes nothing', () => {
		const cwd = tmp()
		writeFileSync(join(cwd, 'PLAN.md'), '   \n  ')
		expect(buildSystemPrompt({ cwd, contextFiles: ['PLAN.md'] })).not.toContain('Pinned context')
	})

	it('no contextFiles option ⇒ no pinned section (inert by default)', () => {
		expect(buildSystemPrompt({ cwd: tmp() })).not.toContain('Pinned context')
	})

	it('pins multiple files, each under its own header', () => {
		const cwd = tmp()
		writeFileSync(join(cwd, 'PLAN.md'), 'the plan')
		writeFileSync(join(cwd, 'CONVENTIONS.md'), 'the conventions')
		const prompt = buildSystemPrompt({ cwd, contextFiles: ['PLAN.md', 'CONVENTIONS.md'] })
		expect(prompt).toContain('## PLAN.md')
		expect(prompt).toContain('the plan')
		expect(prompt).toContain('## CONVENTIONS.md')
		expect(prompt).toContain('the conventions')
	})

	it('caps an oversized pinned file and tells the model where to read the rest', () => {
		const cwd = tmp()
		const big = `HEAD ${'x'.repeat(4000)} TAIL`
		writeFileSync(join(cwd, 'PLAN.md'), big)
		const prompt = buildSystemPrompt({ cwd, contextFiles: ['PLAN.md'] })
		expect(prompt).toContain('HEAD') // the head survives
		expect(prompt).not.toContain('TAIL') // the tail is clipped
		expect(prompt).toContain('truncated') // and the model is told
		expect(prompt).toContain('Read PLAN.md') // …where to get the rest
	})

	it('the pinned block lands OUTSIDE the compactable history (in the system prompt) after the rules', () => {
		const cwd = tmp()
		writeFileSync(join(cwd, 'PLAN.md'), 'CONTRACT')
		const prompt = buildSystemPrompt({ cwd, extraInstructions: 'BUILDER RULES', contextFiles: ['PLAN.md'] })
		// pinned content appears, and after the frontend rules that tell the model to follow it
		expect(prompt.indexOf('BUILDER RULES')).toBeLessThan(prompt.indexOf('CONTRACT'))
	})
})
