// The Write case-collision guard (dokar/qwen3.5-9B forensics, 2026-08-09): the model wrote
// `tasks/taskList.tsx` twice and `tasks/TaskList.tsx` once — the same file on a case-insensitive
// filesystem — so the two "components" silently overwrote each other while imports of both names kept
// the build broken across five runs. Writing a name that differs from an existing sibling only by case
// is rejected with the existing name spelled out.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WriteTool } from '../src/tools/builtins/Write'

const ctx = (cwd: string) => ({ cwd }) as never

describe('Write — case-collision guard', () => {
	it('rejects a write whose name differs from an existing sibling only by CASE, naming the existing file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wcase-'))
		const first = await WriteTool.call({ file_path: 'TaskList.tsx', content: 'export const TaskList = 1' }, ctx(dir))
		expect(first.isError).toBeFalsy()

		const collide = await WriteTool.call({ file_path: 'taskList.tsx', content: 'export const other = 2' }, ctx(dir))
		expect(collide.isError).toBe(true)
		expect(collide.content).toContain('"TaskList.tsx"') // names the file that already holds the spot
		expect(collide.content).toMatch(/case/i)

		// The original is untouched and remains the only file.
		expect(await readFile(join(dir, 'TaskList.tsx'), 'utf8')).toBe('export const TaskList = 1')
		expect((await readdir(dir)).filter((f) => f.toLowerCase() === 'tasklist.tsx')).toEqual(['TaskList.tsx'])
	})

	it('exact-name overwrite and brand-new files (including new directories) are untouched', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wcase-'))
		await WriteTool.call({ file_path: 'App.tsx', content: 'v1' }, ctx(dir))
		const overwrite = await WriteTool.call({ file_path: 'App.tsx', content: 'v2' }, ctx(dir))
		expect(overwrite.isError).toBeFalsy()
		expect(await readFile(join(dir, 'App.tsx'), 'utf8')).toBe('v2')

		// Parent dir does not exist yet — the readdir probe must not block creation.
		const fresh = await WriteTool.call({ file_path: 'src/components/New.tsx', content: 'new' }, ctx(dir))
		expect(fresh.isError).toBeFalsy()
	})
})

describe('Write — package.json dependency-removal guard (hotelnow forensics, 2026-08-10)', () => {
	// The measured failure: the model rewrote package.json into its Tailwind-v3 training prior, dropping
	// @tailwindcss/vite — which the preview's force-restored template vite.config.ts imports. Preview
	// failed with "Cannot find package" on every start.
	const V4 = JSON.stringify({ name: 'app', dependencies: { react: '^18' }, devDependencies: { '@tailwindcss/vite': '^4.0.0', tailwindcss: '^4.0.0', vite: '^5' } })
	const V3_REWRITE = JSON.stringify({ name: 'hotelnow', dependencies: { react: '^18' }, devDependencies: { tailwindcss: '^3.4.17', postcss: '^8', autoprefixer: '^10', vite: '^6' } })

	it('rejects a rewrite that drops declared deps, naming exactly what was removed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wpkg-'))
		await WriteTool.call({ file_path: 'package.json', content: V4 }, ctx(dir))
		const res = await WriteTool.call({ file_path: 'package.json', content: V3_REWRITE }, ctx(dir))
		expect(res.isError).toBe(true)
		expect(res.content).toContain('@tailwindcss/vite')
		expect(res.content).not.toContain('tailwindcss,') // still declared (v3) — not reported as removed
		expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(V4) // original untouched
	})

	it('adding deps, moving between sections, and fresh creation all pass', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wpkg-'))
		const fresh = await WriteTool.call({ file_path: 'package.json', content: V4 }, ctx(dir))
		expect(fresh.isError).toBeFalsy() // no prior file — nothing can be removed
		const moved = JSON.stringify({ name: 'app', dependencies: { react: '^18', tailwindcss: '^4.0.0', '@tailwindcss/vite': '^4.0.0', vite: '^5', 'lucide-react': '^0.469.0' }, devDependencies: {} })
		const res = await WriteTool.call({ file_path: 'package.json', content: moved }, ctx(dir))
		expect(res.isError).toBeFalsy() // every old dep still declared somewhere + one added
	})

	it('unparseable JSON is not this guard\'s problem (the build reports it)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wpkg-'))
		await WriteTool.call({ file_path: 'package.json', content: V4 }, ctx(dir))
		const res = await WriteTool.call({ file_path: 'package.json', content: '{ broken json' }, ctx(dir))
		expect(res.isError).toBeFalsy() // guard abstains; other layers own malformed-manifest errors
	})

	it('non-manifest files are untouched by the guard', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wpkg-'))
		await WriteTool.call({ file_path: 'data.json', content: V4 }, ctx(dir))
		const res = await WriteTool.call({ file_path: 'data.json', content: '{}' }, ctx(dir))
		expect(res.isError).toBeFalsy()
	})
})

describe('Write — overwrite freshness gate (batch-3: the App.tsx-vaporizer hole)', () => {
	// Edit has always required Read-before-change; Write did not — so an agent told "PLAN files are targets
	// to create" could Write an EXISTING scaffold file (App.tsx) and silently destroy wiring it never saw.
	const ctxWithState = (cwd: string) => {
		const state = new Map()
		return { ctx: { cwd, readFileState: state } as never, state }
	}

	it('refuses to overwrite an existing file the model never read; allows it after a read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wfresh-'))
		writeFileSync(join(dir, 'App.tsx'), 'scaffold wiring the model has not seen')
		const { ctx, state } = ctxWithState(dir)

		const blind = await WriteTool.call({ file_path: 'App.tsx', content: 'vaporized' }, ctx)
		expect(blind.isError).toBe(true)
		expect(blind.content).toContain('has not been read')
		expect(await readFile(join(dir, 'App.tsx'), 'utf8')).toBe('scaffold wiring the model has not seen')

		// A Read (simulated the way Read.ts records it) unlocks the overwrite.
		state.set(join(dir, 'App.tsx'), { content: 'scaffold wiring the model has not seen', timestamp: Date.now() + 1000 })
		const seen = await WriteTool.call({ file_path: 'App.tsx', content: 'deliberate rewrite' }, ctx)
		expect(seen.isError).toBeFalsy()
	})

	it('new files need no read, and the model\'s own Write counts as knowledge (ADR-032)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wfresh-'))
		const { ctx } = ctxWithState(dir)
		const first = await WriteTool.call({ file_path: 'data.ts', content: 'v1' }, ctx)
		expect(first.isError).toBeFalsy() // brand-new — no read required
		const second = await WriteTool.call({ file_path: 'data.ts', content: 'v2' }, ctx)
		expect(second.isError).toBeFalsy() // its own write registered the knowledge
		expect(await readFile(join(dir, 'data.ts'), 'utf8')).toBe('v2')
	})

	it('no freshness cache wired (headless smokes) ⇒ gate is inert', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wfresh-'))
		writeFileSync(join(dir, 'x.ts'), 'old')
		const res = await WriteTool.call({ file_path: 'x.ts', content: 'new' }, ctx(dir))
		expect(res.isError).toBeFalsy()
	})
})
