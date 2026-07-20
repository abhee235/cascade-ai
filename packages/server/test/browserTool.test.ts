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
