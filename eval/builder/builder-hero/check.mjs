// builder-hero check — BEHAVIOURAL: the app must BUILD (vite build exit 0) and the built bundle must carry
// the requested UI text (string-through-build: if the strings survive bundling, they're in the rendered tree
// or dead-code-eliminated JSX — good enough for a v1 oracle; a headless-DOM render is the v2 upgrade).
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const build = spawnSync(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { encoding: 'utf8', timeout: 120_000 })
if (build.status !== 0) {
	console.error('vite build FAILED:\n' + (build.stderr || build.stdout).slice(-1500))
	process.exit(1)
}
const bundle = readdirSync(join('dist', 'assets'))
	.filter((f) => f.endsWith('.js'))
	.map((f) => readFileSync(join('dist', 'assets', f), 'utf8'))
	.join('\n')
for (const needle of ['Ship it with Cascade', 'Get started']) {
	if (!bundle.includes(needle)) {
		console.error(`built bundle is missing the required text: "${needle}"`)
		process.exit(1)
	}
}
console.log('builder-hero check passed')
