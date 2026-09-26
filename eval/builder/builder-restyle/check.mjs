// builder-restyle check — the P5 loop measured in MODEL hands: turn 1 builds a small gallery, turn 2 asks
// for "dark, luxurious … flatter and sharper: hard edges, no rounded corners". The correct move is TWO
// Restyle calls (preset luxe-dark + skin sharp); hand-editing themes/blocks is refused by the frozen-path
// guard, so a model that never finds the tool fails here on the look never changing.
//
// The skin assertion is BYTE-EQUALITY against the shipped skin file, not a marker grep: only the Restyle
// tool (or a byte-perfect copy the guard would refuse to write) produces that content. It also doubles as
// a drift alarm — if skins/sharp changes, this fixture's solution goes stale and --verify says so.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { noResidue } from '../_lib/residue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(HERE, '..', '..', '..', 'packages', 'server', 'templates', 'react')

const build = spawnSync(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { encoding: 'utf8', timeout: 180_000 })
if (build.status !== 0) {
	console.error('vite build FAILED:\n' + (build.stderr || build.stdout).slice(-1500))
	process.exit(1)
}

// 1. The dark ask: luxe-dark is the template's one dark preset, and the @import line is the mechanism.
const css = readFileSync(join('src', 'index.css'), 'utf8')
if (!css.includes("@import './themes/luxe-dark.css'")) {
	const active = css.match(/@import\s+'\.\/themes\/([a-z-]+)\.css'/)?.[1] ?? '(none)'
	console.error(`the dark restyle never happened — active preset is "${active}", expected luxe-dark (the Restyle tool's op "preset" does this in one call)`)
	process.exit(1)
}

// 2. The sharp ask: every block the sharp skin covers must be the skin's bytes — swapped, not hand-edited.
const skinDir = join(TEMPLATE, 'skins', 'sharp', 'blocks')
for (const f of readdirSync(skinDir)) {
	const local = join('src', 'components', 'blocks', f)
	if (!existsSync(local)) {
		console.error(`src/components/blocks/${f} is missing — the sharp skin was never applied (Restyle op "skin")`)
		process.exit(1)
	}
	const want = readFileSync(join(skinDir, f), 'utf8').replace(/\r\n/g, '\n')
	const got = readFileSync(local, 'utf8').replace(/\r\n/g, '\n')
	if (want !== got) {
		console.error(`src/components/blocks/${f} does not match the shipped sharp skin — the flat/sharp restyle never happened (or the block was hand-modified). Restyle {op:"skin", skin:"sharp"} is the mechanism.`)
		process.exit(1)
	}
}

// 3. The app survived the restyle: same brand, same catalog, build above already green.
const bundle = readdirSync(join('dist', 'assets'))
	.filter((f) => f.endsWith('.js'))
	.map((f) => readFileSync(join('dist', 'assets', f), 'utf8'))
	.join('\n')
if (!bundle.toLowerCase().includes('halide supply')) {
	console.error('built bundle is missing "Halide Supply" — the restyle lost the app itself')
	process.exit(1)
}

if (noResidue(process.cwd()) > 0) process.exit(1)
console.log('builder-restyle check passed')
