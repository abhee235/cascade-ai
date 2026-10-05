// residue.mjs — eval-side twin of the TemplateAudit tool's HARD findings (design-overhaul P1): assert no
// template residue survived into the generated app. Reads the SAME contract the product reads
// (templates/react/residue.json), so the bench and the tool can never disagree about what residue IS.
// Fixture invariant holds by construction: a fresh scaffold carries data-placeholder markers (FAILS);
// a finished solution carries none (PASSES).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBlankStart } from './designLint.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = resolve(HERE, '..', '..', '..', 'packages', 'server', 'templates', 'react', 'residue.json')

const SKIP = new Set(['node_modules', 'dist', '.git', '.cascade'])
const SCAN_EXT = /\.(tsx?|jsx?|css|html|json|md)$/

function* walk(dir) {
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (!SKIP.has(e.name)) yield* walk(join(dir, e.name))
		} else if (SCAN_EXT.test(e.name)) yield join(dir, e.name)
	}
}

/** Assert the project at `projectDir` carries no HARD residue. Prints one line per hit; returns hit count. */
export function noResidue(projectDir) {
	if (isBlankStart(projectDir)) return 0 // ADR-086: a blank project never had template residue to remove
	const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
	let failures = 0
	const fail = (msg) => {
		console.error(`residue: ${msg}`)
		failures++
	}
	// `requires`: corroboration for a needle that is ordinary English (see ResidueFinding.requires). The
	// tool honours it, so the bench must too — this file exists to guarantee they agree about what residue
	// IS, and a needle that fires here but not there is exactly the disagreement it was written to prevent.
	const corroborated = (requires) =>
		requires.some((r) => {
			if (!r.startsWith('@/')) return existsSync(join(projectDir, r))
			for (const file of walk(join(projectDir, 'src'))) if (readFileSync(file, 'utf8').includes(r)) return true
			return false
		})

	for (const f of contract.hard) {
		if (f.requires?.length && !corroborated(f.requires)) continue
		if (f.kind === 'path' && f.path) {
			if (existsSync(join(projectDir, f.path))) fail(`${f.path} still exists — ${f.why}`)
		} else if (f.kind === 'string' && f.needle) {
			const scope = join(projectDir, f.scope ?? 'src')
			for (const file of walk(scope)) {
				if (readFileSync(file, 'utf8').includes(f.needle)) {
					fail(`"${f.needle}" found in ${file.slice(projectDir.length + 1)} — ${f.why}`)
					break
				}
			}
		} else if (f.kind === 'file' && f.path && f.mustNotContain) {
			try {
				if (readFileSync(join(projectDir, f.path), 'utf8').includes(f.mustNotContain)) {
					fail(`${f.path} still contains "${f.mustNotContain}" — ${f.why}`)
				}
			} catch {
				/* file absent — fine */
			}
		}
	}
	return failures
}
