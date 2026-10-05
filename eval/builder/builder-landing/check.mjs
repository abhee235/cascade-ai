// builder-landing check — a landing page is a SEQUENCE OF BANDS, and the failure mode is a page that
// stops after the hero. So the assertions are structural: the bands the brief lists must be present as
// data-block facts, the pricing must be real, and the copy must not be placeholder.
//
// Case-insensitive matching, same reasoning as the other fixtures: these measure that a SURFACE exists.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runDesignLint } from '../_lib/designLint.mjs'
import { noResidue } from '../_lib/residue.mjs'
import { productBuild } from '../_lib/productBuild.mjs'

const build = productBuild(180_000)
if (build.status !== 0) {
	console.error("npm run build FAILED (the product's own check: typecheck + bundle):\n" + (build.stdout + build.stderr).slice(-1500))
	process.exit(1)
}
const bundle = readdirSync(join('dist', 'assets'))
	.filter((f) => f.endsWith('.js'))
	.map((f) => readFileSync(join('dist', 'assets', f), 'utf8'))
	.join('\n')
const haystack = bundle.toLowerCase()

if (!haystack.includes('ferrite')) {
	console.error('built bundle is missing "Ferrite" — the product name never reaches the page')
	process.exit(1)
}

// PLACEHOLDER COPY is the measured landing failure: bands that exist but say nothing. These are strings
// no real marketing page contains.
// The needles must be strings that ONLY appear as placeholder copy. The bare word "placeholder" was
// tried and removed: it matches `data-[placeholder]:` in the Select kit component and the `placeholder`
// attribute on every Input, so it failed this very solution. A check that fails correct code is worse
// than no check.
const placeholders = ['lorem ipsum', 'feature one', 'feature two', 'your headline here', 'headline goes here', 'tier one', 'your company', 'acme inc']
const found = placeholders.filter((p) => haystack.includes(p))
if (found.length) {
	console.error(`built bundle contains placeholder copy: ${found.join(', ')} — write real copy for every band`)
	process.exit(1)
}

// PRICING must be real: three tiers means at least three distinct prices on the page.
const prices = new Set(bundle.match(/\$\s?\d[\d,]*/g) ?? [])
if (prices.size < 2) {
	console.error(`built bundle shows ${prices.size} distinct prices — the brief asks for three pricing tiers (a "Custom" tier counts as one, so ≥2 numeric prices are expected)`)
	process.exit(1)
}

// FAQ depth: four questions means at least four question marks in page copy.
const questions = (bundle.match(/\?"/g) ?? []).length + (bundle.match(/\?`/g) ?? []).length
if (questions < 4) {
	console.error(`built bundle shows ${questions} question strings — the brief asks for an FAQ of at least four questions`)
	process.exit(1)
}

// The BANDS, as data-block facts. This is the "it stopped after the hero" guard.
// `preset: '*'` — the brief names no look, and which preset suits a SaaS page is taste.
// `imagery: false` is NOT used here: a landing page without a single image is the flat-page failure.
if (
	runDesignLint(bundle, {
		blocks: ['navbar', 'hero', 'pricing-table', 'faq', 'cta-section', 'footer'],
		preset: '*',
		quality: process.env.EVAL_BAR === 'quality',
	}) > 0
)
	process.exit(1)

if (noResidue(process.cwd()) > 0) process.exit(1)
console.log('builder-landing check passed')
