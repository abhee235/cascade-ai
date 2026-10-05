// The PRODUCT's done-check, not a bench shortcut: `npm run build` — for the React template `tsc -b && vite build`,
// for a blank project the build script its architecture skill had it write (typecheck, then bundle).
// Measured (ADR-086 P1): the checks ran `vite build` alone, which bundles WITHOUT type-checking, so a shop whose
// checkout referenced an undefined variable (`confirmed`) passed while `tsc -b` was red — and the page crashed.
import { spawnSync } from 'node:child_process'

/** Runs `npm run build` in the scenario's workdir (the check's cwd). Output: stdout carries tsc's errors,
 *  stderr npm's and vite's — callers print both. One command string through the shell (npm is a .cmd shim on
 *  Windows; an argv array with shell:true is deprecated). */
export function productBuild(timeout = 180_000) {
	return spawnSync('npm run build', { encoding: 'utf8', timeout, shell: true })
}
