// builder-graduate check (ADR-066) — the app must PROGRESSIVELY GRADUATE prototype → backend:
//   Prototype (prompt 1): persist via the createStore SEAM, not raw localStorage in a view.
//   Backend   (prompt 2): apply the backend PACK (ApplyPack), add a Prisma model, expose it, and SWAP the
//                         seam to the API store — all WITHOUT the frontend build breaking.
//
// Offline by construction: the check only runs `vite build` (bundles src/ — server/ is outside it and never
// installed), plus filesystem/text assertions on the graduation artifacts. It never runs the server, npm
// install, or prisma — so it stays fast and deterministic even though a real backend was wired.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const fail = (msg) => {
	console.error(`builder-graduate: ${msg}`)
	process.exit(1)
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

// 1) The frontend still BUILDS after graduating (the interoperability contract: swapping the seam to the
//    API store must not break a single view).
const build = spawnSync(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { encoding: 'utf8', timeout: 120_000 })
if (build.status !== 0) fail(`vite build FAILED after graduation:\n${(build.stderr || build.stdout).slice(-1500)}`)

// 2) The backend PACK was applied (not hand-rolled): its signature files exist.
for (const f of ['server/index.ts', 'prisma/schema.prisma', 'src/lib/storage.api.ts']) {
	if (!existsSync(f)) fail(`missing "${f}" — the backend pack was not applied via ApplyPack (or was hand-rolled instead)`)
}

// 3) A REAL Prisma model was added (not just the commented example the pack ships).
const schema = read('prisma/schema.prisma')
if (!/^\s*model\s+\w+\s*\{/m.test(schema)) fail('prisma/schema.prisma has no uncommented `model` — no real table was defined')

// 4) The API route was exposed for the model — a RESOURCES entry with a string-literal path (the pack's
//    empty type annotation `path: string` must NOT count), or an explicit /api route.
const server = read('server/index.ts')
if (!/\{\s*path:\s*['"`]/.test(server) && !/app\.(get|post)\(\s*['"`]\/api\//.test(server)) {
	fail('server/index.ts exposes no /api resource — the model was not wired into the API (RESOURCES is still empty)')
}

// 5) The SEAM was swapped to the API store (the one-line graduation): storage.ts now routes through the
//    API factory. Views/hooks stay unchanged — the whole point of the seam.
const seam = read('src/lib/storage.ts')
if (!/createApiStore/.test(seam) && !/from ['"]\.\/storage\.api['"]/.test(seam)) {
	fail('src/lib/storage.ts was not switched to the API store (expected a re-export of createApiStore) — the frontend is still browser-only')
}

// 6) COLLECTION data goes through the seam, not raw localStorage. Scalar UI preferences (theme/dark
//    mode/sidebar) are explicitly ALLOWED to use localStorage directly (per the data skill) — so we only
//    flag localStorage whose key is NOT a known scalar preference. (Storing a collection looks like
//    localStorage.setItem('notes', …); a theme toggle is localStorage.setItem('theme', 'dark').)
const SCALAR_PREF_KEY = /localStorage\.(get|set|remove)Item\(\s*['"`](theme|dark|mode|color-?mode|sidebar|collapsed|pref\w*|ui[-_]?\w*)['"`]/i
const srcFiles = walk('src').filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/lib[\\/]storage(\.api)?\.ts$/.test(f) && !/[\\/]demo[\\/]/.test(f))
const rawLs = srcFiles.filter((f) => {
	const src = read(f)
	// strip the allowed scalar-preference calls, then see if any localStorage use remains
	return /localStorage\.(get|set|remove)Item/.test(src.replace(new RegExp(SCALAR_PREF_KEY, 'gi'), ''))
})
if (rawLs.length) fail(`raw localStorage for COLLECTION data (must go through the seam; theme/UI-prefs are fine): ${rawLs.join(', ')}`)

console.log('builder-graduate check passed — prototype persisted via the seam AND graduated to a backend, frontend still builds')

function walk(dir) {
	if (!existsSync(dir)) return []
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name)
		return e.isDirectory() ? walk(p) : [p]
	})
}
