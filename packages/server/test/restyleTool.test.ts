// Restyle (design-overhaul P5): presets swap TOKENS, skins swap STRUCTURE, and the whole feature rides on
// two invariants — a skin block's interface is identical to base (parity), and the audit treats any
// shipped variant as pristine (else a restyle teaches the model to undo the user's restyle). Tests here
// cover the mechanics against the REAL template, not fixtures: the react template is the product.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { activePreset, applySkin, listPresets, listSkins, setPreset, templateFilePath } from '../src/templates.js'
import { createRestyleTool } from '../src/restyleTool.js'
import { createTemplateAuditTool } from '../src/auditTool.js'

const dirs: string[] = []
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A minimal themed project: real themes + real blocks copied from the template (not the whole scaffold —
 *  the tests only exercise src/themes, src/index.css and src/components/blocks). */
function project(): string {
	const dir = mkdtempSync(join(tmpdir(), 'restyle-'))
	dirs.push(dir)
	mkdirSync(join(dir, 'src'), { recursive: true })
	cpSync(templateFilePath('react', 'src/themes'), join(dir, 'src', 'themes'), { recursive: true })
	cpSync(templateFilePath('react', 'src/components/blocks'), join(dir, 'src', 'components', 'blocks'), { recursive: true })
	cpSync(templateFilePath('react', 'src/index.css'), join(dir, 'src', 'index.css'))
	return dir
}

describe('presets — one @import line, mechanically', () => {
	it('setPreset rewrites the line and reports the transition', () => {
		const dir = project()
		expect(activePreset(dir)).toBe('premium')
		expect(setPreset(dir, 'luxe-dark')).toBe('premium → luxe-dark')
		expect(activePreset(dir)).toBe('luxe-dark')
		expect(readFileSync(join(dir, 'src', 'index.css'), 'utf8')).toContain("@import './themes/luxe-dark.css'")
	})

	it('an unknown preset fails naming what IS available', () => {
		const dir = project()
		expect(() => setPreset(dir, 'vaporwave')).toThrow(/vaporwave.*aurora-glass/s)
		expect(activePreset(dir)).toBe('premium') // nothing changed on failure
	})
})

describe('skins — certified structure swaps', () => {
	it('the sharp skin applies wholesale, and unlisted blocks stay base', () => {
		const dir = project()
		const log = applySkin(dir, 'react', 'sharp')
		expect(log).toContain('sharp')
		const sharp = listSkins('react').find((s) => s.id === 'sharp')!
		for (const b of sharp.blocks) {
			expect(readFileSync(join(dir, 'src', 'components', 'blocks', `${b}.tsx`), 'utf8')).toContain('SKIN: sharp')
		}
		// A block the skin does not cover is byte-identical to base. (Was Section until the skins grew to
		// cover it — CartRow has no skin variant in either pack.)
		expect(readFileSync(join(dir, 'src', 'components', 'blocks', 'CartRow.tsx'), 'utf8')).toBe(readFileSync(templateFilePath('react', 'src/components/blocks/CartRow.tsx'), 'utf8'))
	})

	it('components narrows the swap; base restores the stock look', () => {
		const dir = project()
		applySkin(dir, 'react', 'sharp', ['MediaCard'])
		expect(readFileSync(join(dir, 'src', 'components', 'blocks', 'MediaCard.tsx'), 'utf8')).toContain('SKIN: sharp')
		expect(readFileSync(join(dir, 'src', 'components', 'blocks', 'Hero.tsx'), 'utf8')).not.toContain('SKIN: sharp')
		applySkin(dir, 'react', 'base')
		expect(readFileSync(join(dir, 'src', 'components', 'blocks', 'MediaCard.tsx'), 'utf8')).not.toContain('SKIN: sharp')
	})

	it('asking a skin for a block it does not ship names its coverage instead of guessing', () => {
		const dir = project()
		expect(() => applySkin(dir, 'react', 'sharp', ['FAQ'])).toThrow(/covers: ArtImage, Footer, Hero, MediaCard, NavBar, Section, StatCard/)
	})
})

describe('the audit ↔ restyle contract', () => {
	const audit = async (dir: string) => String((await createTemplateAuditTool({ projectDir: dir, templateId: 'react' })!.call({} as never, {} as never)).content)

	it('a skin-swapped block is NOT an edit — any shipped variant counts as pristine', async () => {
		const dir = project()
		applySkin(dir, 'react', 'sharp')
		expect(await audit(dir)).not.toContain('EDITED')
	})

	it('a hand-edited block is still flagged, and the fix points at Restyle', async () => {
		const dir = project()
		const hero = join(dir, 'src', 'components', 'blocks', 'Hero.tsx')
		writeFileSync(hero, readFileSync(hero, 'utf8').replace('max-w-xl', 'max-w-2xl'))
		const out = await audit(dir)
		expect(out).toContain('EDITED')
		expect(out).toContain('Restyle')
	})
})

describe('parity — a skin may change markup, never the interface', () => {
	// The type-level checker (skins/parity.check.ts) catches narrowed/changed/missing props but is BLIND to
	// extra OPTIONAL props (width subtyping — proven by drifting on purpose). This textual check closes that
	// hole: the exact prop-name set of each interface pair must match, optionality included.
	const props = (text: string): string[] => {
		const body = text.match(/export interface \w+Props[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ''
		return [...body.matchAll(/^\t([A-Za-z]+\??):/gm)].map((m) => m[1]).sort()
	}

	it('every skin block declares exactly the base prop set', () => {
		for (const skin of listSkins('react')) {
			for (const b of skin.blocks) {
				const base = readFileSync(templateFilePath('react', `src/components/blocks/${b}.tsx`), 'utf8')
				const themed = readFileSync(templateFilePath('react', `skins/${skin.id}/blocks/${b}.tsx`), 'utf8')
				expect(props(themed), `${skin.id}/${b}`).toEqual(props(base))
				// And the designLint contract survives the swap: same data-block stamp.
				const stamp = (t: string) => t.match(/data-block="([a-z-]+)"/)?.[1]
				expect(stamp(themed), `${skin.id}/${b} data-block`).toBe(stamp(base))
			}
		}
	})

	it('every skin block is covered by the type-level checker too', () => {
		const check = readFileSync(templateFilePath('react', 'skins/parity.check.ts'), 'utf8')
		for (const skin of listSkins('react')) {
			for (const b of skin.blocks) expect(check, `parity.check.ts must import ${skin.id}/${b}`).toContain(`./${skin.id}/blocks/${b}`)
			// …and the manifest matches the files actually shipped.
			const files = readdirSync(templateFilePath('react', `skins/${skin.id}/blocks`)).map((f) => f.replace('.tsx', '')).sort()
			expect(files).toEqual([...skin.blocks].sort())
		}
	})
})

describe('the tool surface', () => {
	it('self-gates on projects without a theme mechanism', () => {
		const bare = mkdtempSync(join(tmpdir(), 'restyle-bare-'))
		dirs.push(bare)
		expect(createRestyleTool({ projectDir: bare, templateId: 'react' })).toBeUndefined()
	})

	it('describes every preset and skin so the model never guesses names', () => {
		const tool = createRestyleTool({ projectDir: project(), templateId: 'react' })!
		for (const p of listPresets(project())) expect(tool.description).toContain(p)
		expect(tool.description).toContain('sharp')
		expect(tool.description).toContain('base')
	})
})
