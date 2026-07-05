// builder-shop check — the app must BUILD and the bundle must carry the storefront the brief mandates.
// Bundle-text assertions are deliberately on EXACT strings the prompt requires, so a half-built app
// (catalog but no checkout, cart but no validation form) fails loudly with the missing piece named.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
for (const [needle, what] of required) {
	if (!bundle.includes(needle)) {
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
console.log('builder-shop check passed')
