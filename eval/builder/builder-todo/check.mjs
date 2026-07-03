// builder-todo check — build must pass and the bundle must carry the requested UI strings.
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
for (const needle of ['What needs doing?', 'Add']) {
	if (!bundle.includes(needle)) {
		console.error(`built bundle is missing the required text: "${needle}"`)
		process.exit(1)
	}
}
console.log('builder-todo check passed')
