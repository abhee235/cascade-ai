// builder-shop-iterate check — after SIX iterative rounds the app must build and carry every feature.
// Assertions target exact strings the prompts mandate, so "which round's work is missing" is named.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { presetFromPlan, runDesignLint } from '../_lib/designLint.mjs'
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

const required = [
	['Cascade Shop', 'round 1: the shop itself'],
	['Add to cart', 'round 1: catalog/detail buttons'],
	['Checkout', 'round 1: checkout flow'],
	['Remove', 'round 1: cart line removal'],
	['Wishlist', 'round 2: the wishlist view'],
	['Move to cart', 'round 2: wishlist → cart'],
	['Search products…', 'round 3: the search input (exact placeholder)'],
	['All', 'round 3: the All category chip'],
	['localStorage', 'round 4: theme persistence'],
	['Orders', 'round 6: order history view'],
]
for (const [needle, what] of required) {
	if (!bundle.includes(needle)) {
		console.error(`built bundle is missing "${needle}" — ${what}`)
		process.exit(1)
	}
}
const priceFields = (bundle.match(/\b(price|cost)\s*[:=]\s*\d/g) ?? []).length
const literalPrices = new Set(bundle.match(/\$\s?\d+(\.\d{2})?/g) ?? []).size
if (literalPrices < 4 && priceFields < 6) {
	console.error(`built bundle shows ${literalPrices} literal prices and ${priceFields} price fields — the catalog looks missing/stubbed`)
	process.exit(1)
}
// Design-system v2: objective design assertions (tokens-only colors, block assembly, real imagery).
// ADR-085 P0 re-baseline (EVAL-BASELINE.md): the preset PLAN.md records, and either card block.
if (runDesignLint(bundle, { blocks: ['navbar', 'product-card|media-card', 'empty-state'], preset: presetFromPlan(), quality: process.env.EVAL_BAR === 'quality' }) > 0) process.exit(1)
console.log('builder-shop-iterate check passed')
