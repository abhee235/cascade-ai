// ADR-056 rung 4 — argument-scoped tool grants. The generic capability wall that production plan-mode
// tools (hosted app builders) use instead of prompting: an agent scoped to `Write(PLAN.md)` physically
// cannot write anything else. Measured need: planner-2/3 proved a system-prompt persona can't hold a
// mid model back from building when it holds an unrestricted Write.

import { describe, expect, it, vi } from 'vitest'
import { scopeToolsByGrants } from '../src/tools/toolGrants'
import type { Tool, ToolContext } from '../src/tools/Tool'

const ctx = { cwd: '/work', abortSignal: new AbortController().signal } as ToolContext

function fakeTool(name: string): Tool & { calls: unknown[] } {
	const calls: unknown[] = []
	return {
		name,
		calls,
		description: name,
		activitySummary: () => name,
		isReadOnly: () => name === 'Read',
		async call(input: unknown) {
			calls.push(input)
			return { content: `${name} ran` }
		},
	} as Tool & { calls: unknown[] }
}

describe('scopeToolsByGrants', () => {
	it('drops tools with no grant (allowlist semantics)', () => {
		const [read, write, bash] = [fakeTool('Read'), fakeTool('Write'), fakeTool('Bash')]
		const out = scopeToolsByGrants([read, write, bash], ['Read', 'Write'])
		expect(out.map((t) => t.name)).toEqual(['Read', 'Write'])
	})

	it('a bare grant passes the tool through untouched (same object)', () => {
		const read = fakeTool('Read')
		const [out] = scopeToolsByGrants([read], ['Read'])
		expect(out).toBe(read) // not wrapped
	})

	it('a scoped grant allows a matching path and runs the real tool', async () => {
		const write = fakeTool('Write')
		const [scoped] = scopeToolsByGrants([write], ['Write(PLAN.md)'])
		expect(scoped).not.toBe(write) // wrapped
		const res = await scoped!.call({ file_path: 'PLAN.md', content: '# plan' }, ctx)
		expect(res.isError).toBeFalsy()
		expect(write.calls).toHaveLength(1) // the real tool actually ran
	})

	it('a scoped grant DENIES a non-matching path with a teaching error and no execution', async () => {
		const write = fakeTool('Write')
		const [scoped] = scopeToolsByGrants([write], ['Write(PLAN.md)'])
		const res = await scoped!.call({ file_path: 'src/App.tsx', content: 'code' }, ctx)
		expect(res.isError).toBe(true)
		expect(res.content).toContain('Write(PLAN.md)') // names the allowed target
		expect(res.content).toContain('src/App.tsx') // names what was tried
		expect(res.content).toMatch(/hard capability limit/i)
		expect(write.calls).toHaveLength(0) // the real tool was NEVER called
	})

	it('multiple scoped grants for one tool are OR-ed', async () => {
		const write = fakeTool('Write')
		const [scoped] = scopeToolsByGrants([write], ['Write(PLAN.md)', 'Write(docs/**)'])
		expect((await scoped!.call({ file_path: 'PLAN.md', content: 'x' }, ctx)).isError).toBeFalsy()
		expect((await scoped!.call({ file_path: 'docs/adr/1.md', content: 'x' }, ctx)).isError).toBeFalsy()
		expect((await scoped!.call({ file_path: 'src/x.ts', content: 'x' }, ctx)).isError).toBe(true)
	})

	it('a bare grant beats a scoped one for the same tool (unrestricted wins)', async () => {
		const write = fakeTool('Write')
		const [out] = scopeToolsByGrants([write], ['Write(PLAN.md)', 'Write'])
		const res = await out!.call({ file_path: 'anywhere.ts', content: 'x' }, ctx)
		expect(res.isError).toBeFalsy()
		expect(write.calls).toHaveLength(1)
	})

	it('grants for tools not present are ignored (no phantom tools)', () => {
		const out = scopeToolsByGrants([fakeTool('Read')], ['Read', 'Bash(git:*)'])
		expect(out.map((t) => t.name)).toEqual(['Read'])
	})

	it('scoping preserves the tool’s other methods (isReadOnly, activitySummary)', () => {
		const write = fakeTool('Write')
		const [scoped] = scopeToolsByGrants([write], ['Write(PLAN.md)'])
		expect(scoped!.isReadOnly?.({} as never)).toBe(false)
		expect(scoped!.activitySummary({} as never)).toBe('Write')
	})

	it('a scoped grant matches SANDBOX-ABSOLUTE aliases of the legal path (the Simmer planner bug)', async () => {
		// Measured: the planner wrote "/workspace/PLAN.md" — the legal file via its sandbox alias — and the
		// raw string match denied it. Grants must normalize to the project-relative form before matching.
		const write = fakeTool('Write')
		const [scoped] = scopeToolsByGrants([write], ['Write(PLAN.md)'])
		const sandboxCtx = { cwd: 'C:/proj', abortSignal: new AbortController().signal, sandbox: { root: '/workspace' } } as unknown as ToolContext
		const ok = await scoped!.call({ file_path: '/workspace/PLAN.md', content: '# plan' }, sandboxCtx)
		expect(ok.isError).toBeFalsy()
		expect(write.calls).toHaveLength(1)
		const deny = await scoped!.call({ file_path: '/workspace/src/App.tsx', content: 'code' }, sandboxCtx)
		expect(deny.isError).toBe(true) // normalization must not widen the grant
	})

	it('Bash grants scope by command prefix (reuses the rule grammar)', async () => {
		const bash = fakeTool('Bash')
		const [scoped] = scopeToolsByGrants([bash], ['Bash(git:*)'])
		expect((await scoped!.call({ command: 'git status' }, ctx)).isError).toBeFalsy()
		expect((await scoped!.call({ command: 'rm -rf /' }, ctx)).isError).toBe(true)
		expect(bash.calls).toEqual([{ command: 'git status' }])
	})
})
