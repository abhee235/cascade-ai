// designSeed — the ADR-085 P0 oracle seed installer, against the REAL seeds and the real template index.css.
import { describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { themeContract, themeContrast } from '../../packages/server/src/designChecks'
import { builtPreset, installSeed, loadSeed, pinPlanPreset } from './designSeed.mts'

const ROOT = join(import.meta.dirname, '..', '..')
const SEEDS = join(ROOT, 'eval', 'design-seeds')
const TEMPLATE_SRC = join(ROOT, 'packages', 'server', 'templates', 'react', 'src')

/** Just the parts of a scaffold a seed touches: src/index.css, src/themes/, AI_RULES.md. */
function workdir(): string {
	const work = mkdtempSync(join(tmpdir(), 'cascade-seed-'))
	mkdirSync(join(work, 'src'), { recursive: true })
	cpSync(join(TEMPLATE_SRC, 'index.css'), join(work, 'src', 'index.css'))
	cpSync(join(TEMPLATE_SRC, 'themes'), join(work, 'src', 'themes'), { recursive: true })
	writeFileSync(join(work, 'AI_RULES.md'), '# AI rules\n\nUse the tokens.\n')
	return work
}

describe('the oracle seeds', () => {
	it.each(['builder-shop', 'builder-landing'])('%s: contract-complete and readable in light AND dark', (scenario) => {
		const seed = loadSeed(SEEDS, scenario)!
		const css = readFileSync(join(seed.dir, seed.theme), 'utf8')
		expect(themeContract(css)).toMatchObject({ ok: true, preset: seed.id, darkVia: 'class' })
		expect(themeContrast(css).failures).toBe(0)
		for (const f of seed.fonts) expect(existsSync(join(seed.dir, f)), f).toBe(true)
		expect(readFileSync(join(seed.dir, seed.brief!), 'utf8').length).toBeLessThanOrEqual(1200)
	})

	it('a scenario without a seed gets none', () => {
		expect(loadSeed(SEEDS, 'builder-todo')).toBeUndefined()
	})
})

describe('installSeed', () => {
	it('B: theme, fonts and the one import line — AI_RULES untouched', () => {
		const work = workdir()
		const seed = loadSeed(SEEDS, 'builder-shop')!
		installSeed(work, seed, false)
		expect(readFileSync(join(work, 'src', 'index.css'), 'utf8')).toContain("@import './themes/cascade-shop.css';")
		expect(readFileSync(join(work, 'src', 'index.css'), 'utf8')).not.toContain('premium.css')
		expect(existsSync(join(work, 'src', 'themes', 'cascade-shop.css'))).toBe(true)
		for (const f of ['nunito-sans-var-latin.woff2', 'rubik-var-latin.woff2', 'LICENSE-rubik.txt']) expect(existsSync(join(work, 'src', 'assets', 'fonts', f)), f).toBe(true)
		expect(readFileSync(join(work, 'AI_RULES.md'), 'utf8')).toBe('# AI rules\n\nUse the tokens.\n')
		expect(existsSync(join(work, 'DESIGN.md'))).toBe(false)
	})

	it('C: B plus DESIGN.md, carried into AI_RULES.md (the product\'s channel for project rules)', () => {
		const work = workdir()
		installSeed(work, loadSeed(SEEDS, 'builder-landing')!, true)
		const rules = readFileSync(join(work, 'AI_RULES.md'), 'utf8')
		expect(rules.startsWith('# AI rules\n\nUse the tokens.\n\n## This project\'s design direction')).toBe(true)
		expect(rules).toContain('# Design direction — Ferrite')
		expect(readFileSync(join(work, 'DESIGN.md'), 'utf8')).toContain('JetBrains Mono')
	})
})

describe('pinPlanPreset', () => {
	const pin = (plan: string | null) => {
		const work = mkdtempSync(join(tmpdir(), 'cascade-pin-'))
		if (plan !== null) writeFileSync(join(work, 'PLAN.md'), plan)
		const how = pinPlanPreset(work, 'cascade-shop')
		return { how, plan: plan === null ? null : readFileSync(join(work, 'PLAN.md'), 'utf8') }
	}

	it('rewrites the preset however the planner spelled it', () => {
		expect(pin('**Design** — category: commerce; preset: premium; catalog: MediaCard grid')).toEqual({ how: 'rewritten', plan: '**Design** — category: commerce; preset: cascade-shop; catalog: MediaCard grid' })
		expect(pin('Design: category: commerce; **preset:** `premium`;').plan).toBe('Design: category: commerce; preset: cascade-shop;')
	})

	it('inserts one after category: when the plan names none, and reports a missing plan', () => {
		expect(pin('**Design** — category: commerce; catalog: grid')).toEqual({ how: 'inserted', plan: '**Design** — category: commerce; preset: cascade-shop; catalog: grid' })
		expect(pin(null)).toEqual({ how: 'no-plan', plan: null })
	})
})

describe('builtPreset', () => {
	it('reads the fingerprint from minified css, and nothing without a build', () => {
		const work = mkdtempSync(join(tmpdir(), 'cascade-built-'))
		expect(builtPreset(work)).toBeUndefined()
		mkdirSync(join(work, 'dist', 'assets'), { recursive: true })
		writeFileSync(join(work, 'dist', 'assets', 'index-abc.css'), ':root{--preset:"cascade-shop";--radius:.75rem}')
		expect(builtPreset(work)).toBe('cascade-shop')
	})
})
