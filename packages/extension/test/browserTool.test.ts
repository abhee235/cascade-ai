// The extension Browser tool (host-run dev server, URL-addressed) — fake page, no real Playwright.

import { describe, expect, it, vi } from 'vitest'
import { createBrowserTool, type PageLike } from '../src/browserTool'

function fakePage(over: Partial<PageLike> = {}): PageLike {
	return {
		goto: vi.fn(async () => undefined),
		title: async () => 'Orbit',
		url: () => 'http://localhost:5173/',
		locator: () => ({ ariaSnapshot: async () => '- heading "Time, reimagined."' }),
		screenshot: async () => Buffer.from('fake-jpeg-bytes'),
		evaluate: async () => ({ ok: 1 }),
		clickText: async () => undefined,
		press: async () => undefined,
		consoleErrors: () => [],
		...over,
	}
}

const ctx = {} as never

describe('extension Browser tool', () => {
	it('open requires a url the FIRST time (there is no fixed preview origin in the IDE)', async () => {
		const tool = createBrowserTool({ launch: async () => ({ page: fakePage(), close: async () => {} }) })
		const r = await tool.call({ op: 'open' }, ctx)
		expect(r.isError).toBe(true)
		expect(r.content).toContain('needs `url`')
	})

	it('open with url, then path-only navigation stays on that origin', async () => {
		const page = fakePage()
		const tool = createBrowserTool({ launch: async () => ({ page, close: async () => {} }) })
		const r1 = await tool.call({ op: 'open', url: 'http://localhost:5173' }, ctx)
		expect(r1.isError).toBeFalsy()
		await tool.call({ op: 'open', path: '/pricing' }, ctx)
		expect(page.goto).toHaveBeenLastCalledWith('http://localhost:5173/pricing', expect.anything())
	})

	it('audit FAILS when scrolled content is stuck at opacity 0 (the three-builds bug)', async () => {
		const page = fakePage({
			evaluate: async () => ({
				pageHeight: 3977,
				steps: [
					{ y: 0, visible: 12, invisible: 0 },
					{ y: 1200, visible: 0, invisible: 11 },
				],
				stuckSamples: ['ORBIT Lite', 'Under the surface'],
			}),
		})
		const tool = createBrowserTool({ launch: async () => ({ page, close: async () => {} }) })
		await tool.call({ op: 'open', url: 'http://localhost:5173' }, ctx)
		const r = await tool.call({ op: 'audit' }, ctx)
		expect(r.isError).toBe(true)
		expect(r.content).toContain('11 INVISIBLE')
		expect(r.content).toContain('ORBIT Lite')
	})

	it('ops before open are rejected with guidance', async () => {
		const tool = createBrowserTool({ launch: async () => ({ page: fakePage(), close: async () => {} }) })
		const r = await tool.call({ op: 'snapshot' }, ctx)
		expect(r.isError).toBe(true)
		expect(r.content).toContain('op:"open"')
	})
})
