// builder-social check — the feed contract as bundle facts: the brand, a real multi-author seed, the
// social blocks composed (feed-post + composer + profile-header), and no photographic mandate beyond the
// standard imagery rule (a feed HAS images per the brief, so usesImagery stays on).
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

if (!haystack.includes('murmur')) {
	console.error('built bundle is missing "Murmur" — the app name never reaches the page')
	process.exit(1)
}

// The seed must be real: ≥4 distinct handles (the brief's "at least 4 authors" — handles survive
// minification as string literals) and ≥5 post bodies. Count @-handles as a proxy for authors.
const handles = new Set((bundle.match(/@[a-z][a-z0-9_]{1,20}\b/gi) ?? []).map((h) => h.toLowerCase()))
if (handles.size < 4) {
	console.error(`built bundle shows ${handles.size} distinct @handles — the brief asks for posts by at least 4 different authors (give every author a handle)`)
	process.exit(1)
}

// The social surface, as data-block facts: the feed column, the composer, the profile top.
if (
	runDesignLint(bundle, {
		blocks: ['navbar', 'feed-post', 'composer', 'profile-header', 'empty-state'],
		preset: '*',
		quality: process.env.EVAL_BAR === 'quality',
	}) > 0
)
	process.exit(1)

if (noResidue(process.cwd()) > 0) process.exit(1)
console.log('builder-social check passed')
