// ADR-033 path jail + the (B2) bare-absolute re-rooting fix. Measured (Simmer 128k run 4): the model wrote
// "/src/components/HomeView.tsx" (dropped the /workspace prefix) — 21 calls denied, and the 80-turn budget
// bled out on the fallout. A bare absolute whose FIRST segment is a real top-level project entry now
// re-roots; genuine host paths and escapes are still rejected.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertPatternInProject, isInsideProject, ProjectPathError, resolveInProject } from '../src/tools/projectPath'
import { ignoresFor as globIgnores } from '../src/tools/builtins/Glob'
import { ignoresFor as grepIgnores } from '../src/tools/builtins/Grep'

const cwd = mkdtempSync(join(tmpdir(), 'projpath-'))
mkdirSync(join(cwd, 'src', 'components'), { recursive: true })
writeFileSync(join(cwd, 'index.html'), '<html></html>')
afterAll(() => rmSync(cwd, { recursive: true, force: true }))

describe('resolveInProject — bare-absolute re-rooting (B2)', () => {
	it('"/src/…" re-roots when src/ exists at the project root', () => {
		expect(resolveInProject(cwd, '/src/components/HomeView.tsx')).toBe(resolve(cwd, 'src/components/HomeView.tsx'))
	})

	it('"/index.html" re-roots for a top-level FILE too', () => {
		expect(resolveInProject(cwd, '/index.html')).toBe(resolve(cwd, 'index.html'))
	})

	it('a genuine host path is still rejected (first segment not in the project)', () => {
		expect(() => resolveInProject(cwd, '/etc/passwd')).toThrow(ProjectPathError)
	})

	it('an escape through a real first segment is still caught by the confinement check', () => {
		expect(() => resolveInProject(cwd, '/src/../../outside.txt')).toThrow(ProjectPathError)
	})

	it('the container aliases still work alongside (B2)', () => {
		expect(resolveInProject(cwd, '/workspace/src/App.tsx')).toBe(resolve(cwd, 'src/App.tsx'))
		expect(resolveInProject(cwd, '/app/src/App.tsx')).toBe(resolve(cwd, 'src/App.tsx'))
	})
})

// ── Glob/Grep PATTERN escapes (2026-07-28 jail audit) ────────────────────────────────────────────────
// Measured hole: `resolveInProject` jails the `path` OPTION, but the pattern went straight to fast-glob —
// `Glob {pattern:"../*.txt"}` listed files outside the root and `Grep {glob:"../*.txt"}` printed their
// CONTENTS. Both tools now assert the pattern AND filter results to the project.
describe('assertPatternInProject — a glob pattern must not escape the project', () => {
	it('rejects parent traversal in every position', () => {
		for (const p of ['..', '../*.txt', '../**/*.ts', 'src/../../etc/*', 'a/..', '..\\windows\\*']) {
			expect(() => assertPatternInProject(p), p).toThrow(ProjectPathError)
		}
	})
	it('rejects absolute patterns (fast-glob honours them regardless of cwd)', () => {
		expect(() => assertPatternInProject('/etc/*')).toThrow(ProjectPathError)
		// Drive-letter absolutes are only absolute ON Windows — assert them there.
		if (process.platform === 'win32') expect(() => assertPatternInProject('C:\\Users\\**')).toThrow(ProjectPathError)
	})
	it('allows ordinary project patterns, including dotted names', () => {
		for (const p of ['**/*.ts', 'src/**/*.tsx', 'package.json', 'src/a..b/*.ts', '**/*.d.ts']) {
			expect(() => assertPatternInProject(p), p).not.toThrow()
		}
	})
})

describe('isInsideProject — result filtering (defense in depth)', () => {
	it('accepts the root and descendants, rejects siblings/parents (real temp paths)', () => {
		const base = mkdtempSync(join(tmpdir(), 'inside-'))
		const root = join(base, 'proj')
		expect(isInsideProject(root, root)).toBe(true)
		expect(isInsideProject(root, join(root, 'src', 'a.ts'))).toBe(true)
		expect(isInsideProject(root, join(base, 'proj-evil', 'a.ts'))).toBe(false) // prefix-sibling, not a child
		expect(isInsideProject(root, join(base, 'SECRET.txt'))).toBe(false)
		rmSync(base, { recursive: true, force: true })
	})
})

// ── Path policy: 'jail' (web builder) vs 'prompt' (extension) ────────────────────────────────────────
describe('pathAccess policy', () => {
	it("jail (DEFAULT) refuses an outside path — the sandboxed builder's guarantee is unchanged", () => {
		expect(() => resolveInProject(cwd, '../outside.txt')).toThrow(ProjectPathError)
		expect(() => resolveInProject(cwd, '../outside.txt', undefined, { policy: 'jail' })).toThrow(ProjectPathError)
	})

	it('prompt RESOLVES an outside path (the permission gate becomes the enforcement point)', () => {
		const abs = resolveInProject(cwd, '../outside.txt', undefined, { policy: 'prompt' })
		expect(abs.endsWith('outside.txt')).toBe(true)
	})

	it('additional roots are treated as inside under EITHER policy (--add-dir)', () => {
		const extra = mkdtempSync(join(tmpdir(), 'extra-'))
		const target = join(extra, 'notes.md')
		expect(resolveInProject(cwd, target, undefined, { roots: [extra] })).toBe(resolve(target))
		expect(isInsideProject(cwd, target)).toBe(false) // …and still outside the project proper
		rmSync(extra, { recursive: true, force: true })
	})
})

// ── Searching INSTALLED packages (3D Solar build, 2026-08-03) ────────────────────────────────────────
// The model needed a library's real .d.ts — the ground truth behind 10 guessed rewrites — but Grep/Glob
// hard-ignored node_modules, so it had to shell out to `grep -r`. Explicit intent now wins over the default.
describe('ignoresFor — node_modules is hidden by default, searchable on request', () => {
	it('keeps the node_modules ignore for ordinary project searches', () => {
		expect(globIgnores('**/*.ts', undefined)).toContain('**/node_modules/**')
		expect(grepIgnores(undefined, 'src')).toContain('**/node_modules/**')
	})
	it('drops it when the pattern or path names node_modules', () => {
		expect(globIgnores('node_modules/@react-three/fiber/**/*.d.ts', undefined)).not.toContain('**/node_modules/**')
		expect(grepIgnores(undefined, 'node_modules/three')).not.toContain('**/node_modules/**')
		expect(grepIgnores('node_modules/**/*.d.ts', undefined)).not.toContain('**/node_modules/**')
	})
	it('still hides dist/.git either way', () => {
		expect(globIgnores('node_modules/x/**', undefined)).toContain('**/dist/**')
	})
})
