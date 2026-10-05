// builder-dashboard check — the app must BUILD and the bundle must carry the four layers the dashboard
// skill contracts for: AppShell chrome, KPI cards, a chart, and a filterable table with an empty state.
//
// Matching is CASE-INSENSITIVE for the same reason as builder-shop: these assertions measure that the
// SURFACE exists, and capitalisation of a label is not the variable under test.
//
// NOTE on imagery: this fixture runs designLint with `imagery: false`. A dashboard is charts, numbers and
// a table; its avatars are initials. Demanding a photograph here would fail correct work and teach models
// to bolt on a decorative image. The emoji ban still applies — a dashboard does not get to render 📊.
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
	['Northwind Ops', 'the app name (sidebar/header brand)'],
	['delayed', 'the delayed status — the row state the brief asks to surface'],
]
for (const [needle, what] of required) {
	if (!haystack.includes(needle.toLowerCase())) {
		console.error(`built bundle is missing "${needle}" — ${what}`)
		process.exit(1)
	}
}

// The dataset must be REAL (≥12 runs). Property names survive minification; computed values do not, so
// count the seed rows by their status/cost fields rather than by rendered text.
const costFields = (bundle.match(/\b(cost|amount|total|price)\s*:\s*\d/g) ?? []).length
const statusFields = (bundle.match(/\b(delivered|delayed|cancelled)\b/gi) ?? []).length
if (costFields < 12 && statusFields < 12) {
	console.error(`built bundle shows ${costFields} cost fields and ${statusFields} status values — the ≥12-run dataset looks missing/stubbed`)
	process.exit(1)
}

// The four contracted layers, as data-block facts.
// `preset: '*'` — the brief deliberately names no look, so ANY applied preset passes. The design skill
// routes dashboards to minimal-mono, but premium is a defensible choice too, and a fixture that demanded
// one would fail correct work over taste.
if (runDesignLint(bundle, { blocks: ['app-shell', 'stat-card', 'chart-card', 'data-table', 'empty-state'], preset: '*', quality: process.env.EVAL_BAR === 'quality', imagery: false }) > 0) process.exit(1)

// QUALITY TIER: numbers must be DERIVED. Minification destroys `useMemo`, so this reads source. A
// dashboard whose KPIs are typed-in strings is the exact failure the skill names — it looks right and
// lies the moment a filter moves.
if (process.env.EVAL_BAR === 'quality') {
	const src = []
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name)
			if (e.isDirectory()) {
				if (e.name !== 'ui' && e.name !== 'blocks') walk(p) // vendored kit + read-only blocks are not the model's logic
			} else if (/\.tsx?$/.test(e.name)) src.push(readFileSync(p, 'utf8'))
		}
	}
	walk('src')
	const app = src.join('\n')
	if (!/useMemo\s*\(/.test(app)) {
		console.error('no useMemo anywhere in src/ — the KPI values are typed in, not derived from the rows (dashboard skill: "if a number never changes, it is decoration, and decoration is a lie here")')
		process.exit(1)
	}
}

if (noResidue(process.cwd()) > 0) process.exit(1)
console.log('builder-dashboard check passed')
