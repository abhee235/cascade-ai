// ADR-060 Phase 1 — the Browser tool: open/snapshot/screenshot against the preview, with a fake page
// (no real Playwright/browser in tests) and a fake sandbox (no Docker).

import { describe, expect, it, vi } from 'vitest'
import { createBrowserTool, type PageLike } from '../src/browserTool'

function fakePage(over: Partial<PageLike> = {}): PageLike {
	return {
		goto: vi.fn(async () => undefined),
		title: async () => 'Simmer',
		url: () => 'http://localhost:32779/',
		locator: () => ({ ariaSnapshot: async () => '- banner "Simmer"\n- heading "My Recipes"\n- button "New Recipe"' }),
		screenshot: async () => Buffer.from('fake-jpeg-bytes'),
		evaluate: async () => ({ mode: 'PLAYING', ball: { x: 10, y: 20, vx: 4, vy: -4 } }),
		clickText: async () => undefined,
		press: async () => undefined,
		...over,
	}
}

const fakeSandbox = (up = true) =>
	({
		getHostPort: async () => 32779,
		execDetached: vi.fn(async () => undefined),
		exec: async () => ({ output: '', exitCode: 0 }),
	}) as never

// The tool probes the preview URL over HTTP; stub fetch so no real server is needed.
function stubFetch(up: boolean) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		if (!up) throw new Error('ECONNREFUSED')
		return new Response('ok')
	})
}

describe('Browser tool (ADR-060)', () => {
	it('open → snapshot → screenshot happy path; screenshot rides as a data-URI image', async () => {
		const f = stubFetch(true)
		const page = fakePage()
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never

		const open = await tool.call({ op: 'open' }, ctx)
		expect(open.isError).toBeFalsy()
		expect(open.content).toContain('Simmer')

		const snap = await tool.call({ op: 'snapshot' }, ctx)
		expect(snap.content).toContain('heading "My Recipes"')

		const shot = await tool.call({ op: 'screenshot' }, ctx)
		expect(shot.images?.[0]).toMatch(/^data:image\/jpeg;base64,/)
		expect(shot.content).toContain('design checklist')
		f.mockRestore()
	})

	it('snapshot/screenshot before open is a directive error, not a crash', async () => {
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page: fakePage(), close: async () => {} }) })
		const res = await tool.call({ op: 'snapshot' }, {} as never)
		expect(res.isError).toBe(true)
		expect(res.content).toContain('op:"open"')
	})

	it('screenshot budget exhausts into a text-first directive', async () => {
		const f = stubFetch(true)
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page: fakePage(), close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		for (let i = 0; i < 8; i++) await tool.call({ op: 'screenshot' }, ctx)
		const over = await tool.call({ op: 'screenshot' }, ctx)
		expect(over.isError).toBe(true)
		expect(over.content).toContain('budget')
		f.mockRestore()
	})
})

describe('Browser probe op (ADR-079 — the game-feedback channel)', () => {
	it('evaluates the expression and returns JSON runtime state', async () => {
		const f = stubFetch(true)
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page: fakePage(), close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		const r = await tool.call({ op: 'probe', expr: '__DEBUG__.state()' }, ctx)
		expect(r.isError).toBeFalsy()
		expect(r.content).toContain('"mode":"PLAYING"')
		expect(r.content).toContain('"vx":4') // velocities present — the tuning signal
		f.mockRestore()
	})

	it('probe without expr / before open → self-correcting errors', async () => {
		const f = stubFetch(true)
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page: fakePage(), close: async () => {} }) })
		const ctx = {} as never
		const early = await tool.call({ op: 'probe', expr: '1+1' }, ctx)
		expect(early.isError).toBe(true) // nothing open yet
		await tool.call({ op: 'open' }, ctx)
		const noExpr = await tool.call({ op: 'probe' }, ctx)
		expect(noExpr.isError).toBe(true)
		expect(noExpr.content).toContain('expr')
		f.mockRestore()
	})

	it('a page-side throw (no __DEBUG__) fails with the contract hint, not a crash', async () => {
		const f = stubFetch(true)
		const page = fakePage({ evaluate: async () => { throw new Error('__DEBUG__ is not defined') } })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		const r = await tool.call({ op: 'probe', expr: '__DEBUG__.state()' }, ctx)
		expect(r.isError).toBe(true)
		expect(r.content).toContain('game-dev skill')
		f.mockRestore()
	})
})

describe('Browser hands + probe ergonomics (ADR-079 Phase 0)', () => {
	it('auto-parenthesizes a bare object-literal probe (the measured eval trap)', async () => {
		const f = stubFetch(true)
		let seen = ''
		const page = fakePage({ evaluate: async (e: string) => { seen = e; return { ok: 1 } } })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		await tool.call({ op: 'probe', expr: '{ phase: __DEBUG__.state().mode }' }, ctx)
		expect(seen.startsWith('(')).toBe(true)
		expect(seen.endsWith(')')).toBe(true)
		f.mockRestore()
	})

	it('click by visible text + press a key', async () => {
		const f = stubFetch(true)
		const clicks: string[] = []
		const keys: string[] = []
		const page = fakePage({ clickText: async (t: string) => { clicks.push(t) }, press: async (k: string) => { keys.push(k) } })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		const c = await tool.call({ op: 'click', target: 'START GAME' }, ctx)
		expect(c.isError).toBeFalsy()
		expect(clicks).toEqual(['START GAME'])
		await tool.call({ op: 'press', target: 'ArrowLeft' }, ctx)
		expect(keys).toEqual(['ArrowLeft'])
		const noTarget = await tool.call({ op: 'click' }, ctx)
		expect(noTarget.isError).toBe(true)
		f.mockRestore()
	})
})
