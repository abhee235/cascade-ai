// builder-appshell check — the screens every app needs and every scaffold skips. The contracted failure
// this measures is the one the app-shell skill names: a view has FOUR states, and shipping only the
// data state (or showing "empty" when a request failed) is the bug.
//
// Case-insensitive string matching, `preset: '*'`, and `imagery: false` for the same reasons as
// builder-dashboard: an account area is forms, rows and lists — it has no photographic surface, and
// demanding one would fail correct work. The emoji ban still applies.
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

const required = [
	['Ledger', 'the app name (brand)'],
	['404', 'the not-found state the brief asks for'],
]
for (const [needle, what] of required) {
	if (!haystack.includes(needle.toLowerCase())) {
		console.error(`built bundle is missing "${needle}" — ${what}`)
		process.exit(1)
	}
}

// The four states + the shell + auth, as data-block facts. error-state and skeleton-list are the two a
// scaffolded app never has, which is exactly why they are asserted rather than assumed.
if (
	runDesignLint(bundle, {
		blocks: ['app-shell', 'auth-card', 'setting-row', 'empty-state', 'error-state', 'skeleton-list'],
		preset: '*',
		quality: process.env.EVAL_BAR === 'quality',
		imagery: false,
	}) > 0
)
	process.exit(1)

// QUALITY TIER: the destructive action must CONFIRM. AlertDialog (not Dialog) is the contracted control —
// it traps focus on the safe option and cannot be dismissed by clicking the backdrop. The data-slot
// strings survive minification; a hand-rolled `window.confirm` does not count, and neither does a plain
// Dialog, because both lose that behaviour.
if (process.env.EVAL_BAR === 'quality') {
	if (!bundle.includes('alert-dialog-content') && !bundle.includes('alert-dialog-action')) {
		console.error('no <AlertDialog> in the bundle — "delete account" must confirm before it acts (app-shell skill: one click must never be enough for an irreversible action)')
		process.exit(1)
	}
}

if (noResidue(process.cwd()) > 0) process.exit(1)
console.log('builder-appshell check passed')
