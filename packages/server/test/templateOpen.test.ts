// ADR-086 P1 — the open React template: one rhythm owned by the bands, a real logo, no stock-icon anchors.
// Static pins on the template and the model-facing examples; the Luna batch measures what they produce.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resourceDir } from '../src/resources'

const TEMPLATE = resourceDir('templates', 'react')
const read = (...p: string[]) => readFileSync(join(TEMPLATE, ...p), 'utf8')
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))

describe('the open React template (ADR-086 P1)', () => {
	it('owns the rhythm in one rule: a band followed by one of its kind drops its bottom padding', () => {
		// Unlayered, so it wins over the spacing utilities (Tailwind v4 puts utilities in the last layer).
		const css = read('src', 'index.css')
		for (const kind of ['plain', 'muted', 'wash']) expect(css).toContain(`[data-band='${kind}']:has(+ [data-band='${kind}'])`)
		expect(css).toMatch(/^\[data-band='plain'\]/m) // at column 0: not inside an @layer block
		// …and through one wrapper either side (p1-react landing-a1 wrapped its bands in anchor divs: 134 px vs 56).
		expect(css).toContain(`[data-band='plain']:has(+ :not([data-band]) > [data-band='plain']:first-child)`)
		expect(css).toContain(`> [data-band='plain']:last-child`)
	})

	it('keeps a full CTA band\'s outline and link actions legible (they rendered white on white, 1.01:1)', () => {
		const cta = read('src', 'components', 'blocks', 'CTASection.tsx')
		for (const v of ['outline', 'link']) expect(cta).toContain(`[&_[data-variant=${v}]]:text-primary-foreground!`)
		expect(read('src', 'components', 'ui', 'button.tsx')).toContain('data-variant={variant}') // what the band keys on
	})

	it('a media slot sizes the media passed in, never every icon inside custom media (200 px timeline icons)', () => {
		const slots = [['src', 'components', 'blocks'], ['skins', 'sharp', 'blocks'], ['skins', 'soft', 'blocks']].flatMap((d) =>
			['BentoGrid.tsx', 'MediaCard.tsx', 'Hero.tsx', 'ProfileHeader.tsx', 'CartRow.tsx'].map((f) => [...d, f]),
		)
		for (const f of slots) {
			let text: string
			try {
				text = read(...f)
			} catch {
				continue // a skin that does not ship this block
			}
			expect(text, f.join('/')).not.toMatch(/\[&_(?:svg|img)\]:size-full/)
		}
	})

	it('no layout block or reference grid can be pushed past a phone screen', () => {
		expect(read('src', 'components', 'blocks', 'CheckoutPanel.tsx')).toMatch(/className=\{cn\('grid grid-cols-1 /)
		expect(read('src', 'components', 'blocks', 'CartRow.tsx')).toContain('sm:flex-row') // controls under the title on a phone
		for (const f of readdirSync(join(TEMPLATE, 'demo', 'pages'))) {
			for (const grid of read('demo', 'pages', f).match(/className="grid [^"]*(?:sm|md|lg|xl):grid-cols-[^"]*"/g) ?? []) expect(grid, f).toContain('grid-cols-1')
		}
	})

	it('bands take an in-page anchor themselves, and the hero grid cannot be pushed past a phone screen', () => {
		for (const f of ['Section.tsx', 'CTASection.tsx']) expect(read('src', 'components', 'blocks', f), f).toMatch(/\bid\?: string/)
		// grid-cols-1 = minmax(0, 1fr): rich hero media (a live product panel) overflowed 390 px by 61 without it.
		for (const f of [['src', 'components', 'blocks', 'Hero.tsx'], ['skins', 'sharp', 'blocks', 'Hero.tsx'], ['skins', 'soft', 'blocks', 'Hero.tsx']]) {
			for (const grid of read(...f).match(/className="grid [^"]*md:grid-cols-2[^"]*"/g) ?? []) expect(grid, f.join('/')).toContain('grid-cols-1')
		}
	})

	it('marks every band root — base and every skin — so the rule can see it', () => {
		const files = [join(TEMPLATE, 'src', 'components', 'blocks'), join(TEMPLATE, 'skins')].flatMap(walk).filter((f) => f.endsWith('.tsx'))
		for (const f of files) {
			const text = readFileSync(f, 'utf8')
			for (const m of text.matchAll(/<section data-block="(section|hero|cta-section)"[^>]*>/g)) expect(m[0], f).toMatch(/data-band=/)
		}
	})

	it('PageHeader is a title row: no padding or container of its own to stack on its Section', () => {
		const header = read('src', 'components', 'blocks', 'PageHeader.tsx').match(/data-block="page-header" className=\{cn\('([^']*)'/)?.[1] ?? ''
		expect(header).not.toMatch(/\b(?:p[ytb]|px|max-w)-/)
	})

	it('ships a Logo block, and the scaffold brand uses it', () => {
		expect(read('src', 'components', 'blocks', 'Logo.tsx')).toContain('data-block="logo"')
		expect(read('src', 'App.tsx')).toMatch(/<Logo name=/)
	})

	it('no example hands the model a bare stock icon as the brand (Store in 8 of 9 shops was copied from one)', () => {
		const bareIconBrand = /brand=\{\s*<>\s*<\w+ className="size-[45] text-primary" \/>/
		const docs = [resourceDir('skills', 'builder'), join(TEMPLATE, 'demo', 'pages')].flatMap(walk).filter((f) => /\.(md|tsx)$/.test(f))
		for (const f of docs) expect(readFileSync(f, 'utf8'), f).not.toMatch(bareIconBrand)
	})
})
