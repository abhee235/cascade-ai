// The template's blocks ARE the design system a generated app inherits, so drift in them is drift in
// every app Cascade builds. These tests pin the values that a human eye catches but a typecheck never
// will — the 2026-08-11 review found card padding split three ways (p-6 ×7, p-5 ×3, p-4 ×1) across
// blocks playing the same role, which is exactly the "spacing looks inconsistent" complaint.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The template SOURCE in the repo (templates.ts's TEMPLATES_DIR resolves the packaged copy at runtime;
// what we lint here is the checked-in source), same idiom as genReference.test.ts.
const TEMPLATE_SRC = join(import.meta.dirname, '..', 'templates', 'react', 'src')
const BLOCKS_DIR = join(TEMPLATE_SRC, 'components', 'blocks')
const THEMES_DIR = join(TEMPLATE_SRC, 'themes')

function blocks(): { name: string; text: string }[] {
	return readdirSync(BLOCKS_DIR)
		.filter((f) => f.endsWith('.tsx'))
		.map((f) => ({ name: f, text: readFileSync(join(BLOCKS_DIR, f), 'utf8') }))
}

describe('design system — spacing', () => {
	// THE CARD UNIT IS 6. shadcn's own Card primitive (which this template vendors) is `py-6` + `px-6`,
	// so 6 is the system's card unit and anything else is off-system. The role split is deliberate and
	// only two values wide:
	//   • standalone bordered card  → p-6   (matched here: `rounded-xl border` and a `p-N` together)
	//   • row inside a divided card → p-4   (SettingRow, CartRow, SkeletonList rows — no border of its
	//                                        own, so it never matches the pattern below)
	it('every standalone bordered card pads at the p-6 card unit', () => {
		const offenders: string[] = []
		for (const { name, text } of blocks()) {
			// Scan CLASS STRINGS, not whole files: a block whose outer div is `rounded-xl border` and whose
			// inner body is `p-4` (MediaCard) is correct, and only a per-string check can tell them apart.
			for (const cls of text.match(/(?:className=|cn\()["'`][^"'`]+["'`]/g) ?? []) {
				if (!/\brounded-xl\b/.test(cls) || !/\bborder\b/.test(cls)) continue
				const pad = cls.match(/\bp-(\d+)\b/)
				if (pad && pad[1] !== '6') offenders.push(`${name}: p-${pad[1]} on a bordered card — the card unit is p-6`)
			}
		}
		expect(offenders, offenders.join('\n')).toEqual([])
	})
})

describe('design system — the preset owns every color', () => {
	// `npx shadcn add sidebar` appends a bare `:root { --sidebar: hsl(0 0% 98%); … }` + `.dark { … }` block
	// to index.css — eight frozen zinc/blue values that NO preset can reach, so a playful or editorial app
	// would render shadcn's default grey sidebar forever. The values were moved into each preset (derived
	// from its own card/primary/accent/border). This fails if a future `shadcn add` reintroduces them.
	it('index.css declares no literal color values — they belong to the presets', () => {
		const css = readFileSync(join(TEMPLATE_SRC, 'index.css'), 'utf8')
		const literals = css.match(/:\s*(?:hsl|rgb|oklch)\([^)]*\)\s*;/g) ?? []
		// oklch() inside the shadow composition is a from-token calculation, not a literal color.
		const offenders = literals.filter((l) => !l.includes('from var('))
		expect(offenders, `literal colors in index.css:\n${offenders.join('\n')}`).toEqual([])
	})

	it('every preset defines the sidebar roles so a sidebar reskins with the theme', () => {
		for (const f of readdirSync(THEMES_DIR).filter((n) => n.endsWith('.css'))) {
			const text = readFileSync(join(THEMES_DIR, f), 'utf8')
			for (const token of ['--sidebar:', '--sidebar-foreground:', '--sidebar-accent:', '--sidebar-border:']) {
				expect(text, `${f} is missing ${token}`).toContain(token)
			}
		}
	})
})

describe('design system — typography', () => {
	const themes = () =>
		readdirSync(THEMES_DIR)
			.filter((f) => f.endsWith('.css'))
			.map((f) => ({ name: f, text: readFileSync(join(THEMES_DIR, f), 'utf8') }))

	it('every preset declares the full font trio', () => {
		for (const { name, text } of themes()) {
			for (const token of ['--font-sans:', '--font-serif:', '--font-mono:']) {
				expect(text, `${name} is missing ${token}`).toContain(token)
			}
		}
	})

	// Presets vary color and radius; before 2026-08-11 they did NOT vary type — all six declared Inter,
	// so the six "looks" were typographically identical. Type is the strongest carrier of personality, so
	// a preset that does not pick its own display face is not really a preset.
	it('presets do not all share one display face', () => {
		const serifs = new Set(themes().map(({ text }) => text.match(/--font-serif:\s*([^,;]+)/)?.[1]?.trim()))
		expect(serifs.size, `every preset declares the same display face: ${[...serifs].join(', ')}`).toBeGreaterThan(1)
	})

	// A display face with ONE weight (Instrument Serif) would be faux-bolded by the blocks' `font-semibold`,
	// which smears the stems. Any preset shipping such a face must also pin the weight.
	it('single-weight display faces pin their weight instead of faux-bolding', () => {
		for (const { name, text } of themes()) {
			const singleWeight = /@font-face[^}]*font-weight:\s*(\d+)\s*;[^}]*}/g
			for (const m of text.matchAll(singleWeight)) {
				if (m[1] === '400' && /Instrument Serif/.test(m[0])) {
					expect(text, `${name} ships a single-weight display face but never pins .font-serif's weight`).toMatch(/\.font-serif\s*{[^}]*font-weight:\s*400/)
				}
			}
		}
	})
})
