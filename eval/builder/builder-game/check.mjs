// builder-game check — the four screens around a game, as bundle facts. The mechanic itself is freeform
// (the game-dev skill owns it); what scaffolded games measurably skip is the FRAME: a menu, a stable HUD,
// a game-over, a persisted leaderboard. `imagery: false` — a reaction game has no photographic surface,
// and demanding one teaches decoration (same reasoning as builder-dashboard).
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
const haystack = bundle.toLowerCase()

const required = [
	['Pulse', 'the game name (menu screen)'],
	['Play again', 'the game-over restart — a game you cannot restart is a demo'],
	['localStorage', 'leaderboard persistence — the top-5 must survive a reload'],
]
for (const [needle, what] of required) {
	if (!haystack.includes(needle.toLowerCase())) {
		console.error(`built bundle is missing "${needle}" — ${what}`)
		process.exit(1)
	}
}

// The round structure must be real: a "N/5" round display (the HUD) or the round count as data.
if (!/[1-5]\s*\/\s*5|round\s*[:=]/i.test(bundle)) {
	console.error('built bundle shows no round indicator — the brief asks for a five-round structure with a round display in the HUD')
	process.exit(1)
}

// `navbar` was required here and REMOVED (2026-08-16, n=2): one correct run composed a NavBar, the next
// built the same complete game full-screen without site chrome — which the brief never asks for, and
// which is a defensible (arguably better) choice for an arcade game. A check that fails correct work
// over taste teaches models to bolt on chrome — the onePrimaryCta/usesImagery/Meridian lesson again.
// `empty-state` stays: the brief explicitly requires the leaderboard's empty state.
if (runDesignLint(bundle, { blocks: ['empty-state'], preset: '*', quality: process.env.EVAL_BAR === 'quality', imagery: false }) > 0) process.exit(1)

if (noResidue(process.cwd()) > 0) process.exit(1)
console.log('builder-game check passed')
