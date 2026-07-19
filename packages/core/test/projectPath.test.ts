// ADR-033 path jail + the (B2) bare-absolute re-rooting fix. Measured (Simmer 128k run 4): the model wrote
// "/src/components/HomeView.tsx" (dropped the /workspace prefix) — 21 calls denied, and the 80-turn budget
// bled out on the fallout. A bare absolute whose FIRST segment is a real top-level project entry now
// re-roots; genuine host paths and escapes are still rejected.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ProjectPathError, resolveInProject } from '../src/tools/projectPath'

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
