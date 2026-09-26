// builder-shop check — the app must BUILD and the bundle must carry the storefront the brief mandates.
// Bundle-text assertions are on the strings the prompt requires, so a half-built app (catalog but no
// checkout, cart but no validation form) fails loudly with the missing piece named.
//
// Matching is CASE-INSENSITIVE (2026-08-11). Measured: a 35B run built every required surface and then
// failed the whole scenario on "Add to Cart" vs the brief's "Add to cart" — a title-cased button label,
// which is what a careful frontier model writes too. What this assertion measures is that the SURFACE
// exists; capitalization is not the variable, and a check that fails correct work teaches models to game
// the bar rather than meet it (the same reasoning that removed onePrimaryCta from designLint).
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runDesignLint } from '../_lib/designLint.mjs'
import { noResidue } from '../_lib/residue.mjs'

const build = spawnSync(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { encoding: 'utf8', timeout: 180_000 })
if (build.status !== 0) {
	console.error('vite build FAILED:\n' + (build.stderr || build.stdout).slice(-1500))
	process.exit(1)
}
const bundle = readdirSync(join('dist', 'assets'))
	.filter((f) => f.endsWith('.js'))
	.map((f) => readFileSync(join('dist', 'assets', f), 'utf8'))
	.join('\n')

const required = [
	['Cascade Shop', 'the shop name (header)'],
	['Add to cart', 'the catalog/detail add-to-cart button'],
	['Checkout', 'the checkout button'],
	['Remove', 'the cart line-item remove button'],
]
const haystack = bundle.toLowerCase()
for (const [needle, what] of required) {
	if (!haystack.includes(needle.toLowerCase())) {
		console.error(`built bundle is missing "${needle}" — ${what}`)
		process.exit(1)
	}
}
// The catalog must be real (≥6 products). Two implementation styles both count: literal "$12.34" strings
// in JSX, or a data array with price fields (property names survive minification; computed prices don't).
const literalPrices = new Set(bundle.match(/\$\s?\d+(\.\d{2})?/g) ?? []).size
const priceFields = (bundle.match(/\b(price|cost)\s*[:=]\s*\d/g) ?? []).length
if (literalPrices < 4 && priceFields < 6) {
	console.error(`built bundle shows ${literalPrices} literal prices and ${priceFields} price fields — the ≥6-product catalog looks missing/stubbed`)
	process.exit(1)
}
// Design-system v2: objective design assertions (tokens-only colors, block assembly, real imagery).
if (runDesignLint(bundle, { blocks: ['navbar', 'media-card', 'empty-state'], preset: 'premium', quality: process.env.EVAL_BAR === 'quality' }) > 0) process.exit(1)
// Design-overhaul P1: no template residue (demo branding, unreplaced placeholders, unwired entry).
if (noResidue(process.cwd()) > 0) process.exit(1)
console.log('builder-shop check passed')
