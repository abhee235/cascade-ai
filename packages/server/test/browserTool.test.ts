// ADR-060 Phase 1 — the Browser tool: open/snapshot/screenshot against the preview, with a fake page
// (no real Playwright/browser in tests) and a fake sandbox (no Docker).

import { describe, expect, it, vi } from 'vitest'
import { browserHostFor, createBrowserTool, type PageLike } from '../src/browserTool'

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

describe('Browser audit (the stuck-at-opacity-0 detector — 3 shipped builds motivated it)', () => {
	const report = (invisible: number) => ({
		pageHeight: 4000,
		steps: [
			{ y: 0, visible: 10, invisible: 0 },
			{ y: 1200, visible: 2, invisible },
		],
		stuckSamples: invisible ? ['Choose your ORBIT', 'Orbit Pro'] : [],
	})

	it('FAILS (isError) when scrolled content is stuck invisible, naming samples', async () => {
		const f = stubFetch(true)
		const page = fakePage({ evaluate: async () => report(8) })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		const r = await tool.call({ op: 'audit' }, ctx)
		expect(r.isError).toBe(true)
		expect(r.content).toContain('stuck at opacity 0')
		expect(r.content).toContain('Choose your ORBIT')
		f.mockRestore()
	})

	it('PASSES on a fully-rendering page; console errors surface when the fake wires them', async () => {
		const f = stubFetch(true)
		const page = fakePage({ evaluate: async () => report(0), consoleErrors: () => ['boom at app.js:1'] })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		const r = await tool.call({ op: 'audit' }, ctx)
		expect(r.isError).toBeFalsy() // stuck content is the FAIL signal; console errors inform but don't block
		expect(r.content).toContain('boom at app.js:1')
		const clean = fakePage({ evaluate: async () => report(0) })
		const tool2 = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page: clean, close: async () => {} }) })
		await tool2.call({ op: 'open' }, ctx)
		const r2 = await tool2.call({ op: 'audit' }, ctx)
		expect(r2.content).toContain('PASS')
		f.mockRestore()
	})
})

describe('Browser without vision (2026-08-10) — the tool stays, only screenshot is gated', () => {
	it('screenshot errors with a redirect to the text channels; snapshot/audit still work', async () => {
		const f = stubFetch(true)
		const page = fakePage({ evaluate: async () => ({ pageHeight: 900, steps: [{ y: 0, visible: 5, invisible: 0 }], stuckSamples: [], css: { sheets: 2, bodyFont: 'Inter', bodyBg: 'rgb(250, 250, 249)' } }) })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), vision: false, launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)

		const shot = await tool.call({ op: 'screenshot' }, ctx)
		expect(shot.isError).toBe(true)
		expect(shot.content).toContain('op:"snapshot"')
		expect(shot.images).toBeUndefined()

		const snap = await tool.call({ op: 'snapshot' }, ctx)
		expect(snap.isError).toBeFalsy()
		const audit = await tool.call({ op: 'audit' }, ctx)
		expect(audit.isError).toBeFalsy()
		expect(audit.content).toContain('2 stylesheet(s)')
		f.mockRestore()
	})

	it('the no-vision description declares screenshot unavailable; the vision one advertises it', () => {
		const blind = createBrowserTool({ sandbox: fakeSandbox(), vision: false })
		expect(blind.description).toContain('NO vision')
		expect(blind.description).toContain('op:"screenshot" is unavailable')
		const sighted = createBrowserTool({ sandbox: fakeSandbox() })
		expect(sighted.description).toContain('op:"screenshot" ONLY for visual judgment')
	})
})

describe('Browser audit CSS ground truth (hotelnow: styles pipeline broke, page rendered unstyled)', () => {
	it('ZERO stylesheets ⇒ FAIL naming the CSS pipeline, even with all content visible', async () => {
		const f = stubFetch(true)
		const page = fakePage({ evaluate: async () => ({ pageHeight: 900, steps: [{ y: 0, visible: 12, invisible: 0 }], stuckSamples: [], css: { sheets: 0, bodyFont: '"Times New Roman"', bodyBg: 'rgba(0, 0, 0, 0)' } }) })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		const r = await tool.call({ op: 'audit' }, ctx)
		expect(r.isError).toBe(true)
		expect(r.content).toContain('ZERO stylesheets')
		f.mockRestore()
	})

	it('audit tolerates fakes without the css field (older report shape)', async () => {
		const f = stubFetch(true)
		const page = fakePage({ evaluate: async () => ({ pageHeight: 900, steps: [{ y: 0, visible: 5, invisible: 0 }], stuckSamples: [] }) })
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		const ctx = {} as never
		await tool.call({ op: 'open' }, ctx)
		const r = await tool.call({ op: 'audit' }, ctx)
		expect(r.isError).toBeFalsy()
		f.mockRestore()
	})
})

describe('browserHostFor — the host runtime gets a Browser too (was Docker-only)', () => {
	it('docker shape passes through; host maps previewPort/startDev with a deps check first', async () => {
		const docker = { getHostPort: async () => 1, exec: async () => ({}), execDetached: async () => undefined, kind: 'docker' }
		expect(browserHostFor(docker as never)).toBe(docker)

		const calls: string[] = []
		const host = {
			kind: 'host',
			previewPort: async () => 51733,
			hasDependencies: async () => false,
			installDependencies: async () => { calls.push('install'); return true },
			startDev: async () => { calls.push('startDev') },
		}
		const adapted = browserHostFor(host as never)!
		expect(await adapted.getHostPort()).toBe(51733)
		await adapted.execDetached('ignored — the adapter owns the command')
		expect(calls).toEqual(['install', 'startDev'])
	})

	// The regression that shipped: `kind` was an enum of two, then ADR-070 added a third. A runtime that
	// implements ProjectRuntime gets a Browser — whatever its kind is called. Keep this parameterised so
	// a FOURTH runtime cannot reintroduce the bug by simply not being thought of.
	it.each(['wsl', 'host', 'podman'])('the %s runtime gets a Browser (no kind allowlist)', async (kind) => {
		const calls: string[] = []
		const runtime = {
			kind,
			previewPort: async () => 4173,
			hasDependencies: async () => false,
			installDependencies: async () => { calls.push('install'); return true },
			startDev: async () => { calls.push('startDev') },
		}
		const adapted = browserHostFor(runtime as never)
		expect(adapted).toBeDefined()
		expect(await adapted!.getHostPort()).toBe(4173)
		await adapted!.execDetached('ignored — the adapter owns the command')
		expect(calls).toEqual(['install', 'startDev'])
	})

	it('undefined runtime ⇒ no Browser tool', () => {
		expect(browserHostFor(undefined)).toBeUndefined()
	})
})

// ADR-086 P0: the headless browser outlived its session — one leaked per model switch or project close, and
// the bench process never exited. session.dispose() now calls Tool.dispose.
describe('Browser dispose (the leaked headless browser)', () => {
	it('closes the browser once; a disposed tool refuses to launch another', async () => {
		const f = stubFetch(true)
		const close = vi.fn(async () => {})
		const launch = vi.fn(async () => ({ page: fakePage(), close }))
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch })
		await tool.call({ op: 'open' }, {} as never)
		await tool.dispose!()
		await tool.dispose!() // idempotent: project close, then server shutdown
		expect(close).toHaveBeenCalledTimes(1)
		expect((await tool.call({ op: 'open' }, {} as never)).isError).toBe(true)
		expect(launch).toHaveBeenCalledTimes(1)
		f.mockRestore()
	})

	it('a browser that finishes launching after dispose is closed, not leaked (dispose mid-turn)', async () => {
		const f = stubFetch(true)
		const close = vi.fn(async () => {})
		let release: (() => void) | undefined
		const launch = () => new Promise<{ page: PageLike; close: () => Promise<void> }>((resolve) => {
			release = () => resolve({ page: fakePage(), close })
		})
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch })
		const opening = tool.call({ op: 'open' }, {} as never)
		await vi.waitFor(() => expect(release).toBeDefined())
		await tool.dispose!() // nothing launched yet — nothing to close
		expect(close).not.toHaveBeenCalled()
		release!()
		expect((await opening).isError).toBe(true)
		expect(close).toHaveBeenCalledTimes(1)
		f.mockRestore()
	})
})

// ADR-089 — measured on the v0.1.0 VM: 8 opens × 33–45 s with no cause given, and one open that killed the
// agent's working server. These use REAL sockets (no fetch stub).
describe('Browser open — preview lifecycle (ADR-089)', () => {
	const freePort = async () => {
		const { createServer } = await import('node:net')
		return new Promise<number>((r) => {
			const srv = createServer().listen(0, '127.0.0.1', () => {
				const port = (srv.address() as { port: number }).port
				srv.close(() => r(port))
			})
		})
	}

	it('a launch that died returns the cause from the log at once — never "run npm run dev"', async () => {
		const port = await freePort()
		const execDetached = vi.fn(async () => undefined)
		const sandbox = {
			getHostPort: async () => port,
			exec: async () => ({ output: '', exitCode: 0 }),
			execDetached,
			devExited: () => true,
			devLog: async () => "'npm.cmd' is not recognized as an internal or external command,\noperable program or batch file.",
		}
		const tool = createBrowserTool({ sandbox: sandbox as never, launch: async () => ({ page: fakePage(), close: async () => {} }) })
		const t0 = Date.now()
		const res = await tool.call({ op: 'open' }, {} as never)
		expect(Date.now() - t0).toBeLessThan(8_000) // the 3 s readiness probe, then no 30 s wait
		expect(res.isError).toBe(true)
		expect(res.content).toContain("'npm.cmd' is not recognized")
		expect(res.content).toContain('process exited')
		expect(res.content).not.toMatch(/with Bash/)
	}, 15_000)

	it('a server that is listening but slow to answer is adopted, not restarted', async () => {
		const { createServer } = await import('node:http')
		const srv = createServer((_req, res) => setTimeout(() => res.end('<title>ok</title>'), 4_000))
		const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)))
		try {
			const execDetached = vi.fn(async () => undefined)
			const sandbox = { getHostPort: async () => port, exec: async () => ({ output: '', exitCode: 0 }), execDetached }
			const tool = createBrowserTool({ sandbox: sandbox as never, launch: async () => ({ page: fakePage(), close: async () => {} }) })
			const res = await tool.call({ op: 'open' }, {} as never)
			expect(res.isError).toBeFalsy()
			expect(execDetached).not.toHaveBeenCalled() // the restart path is what killed the VM agent's Vite
		} finally {
			srv.closeAllConnections()
			srv.close()
		}
	}, 20_000)
})

// ADR-090 §1/§3 — USE the main flow once: type into a field, then an audit that catches a page the crash blanked.
describe('Browser type + blank-page audit (ADR-090)', () => {
	it('type fills the field and presses Enter when submit is set', async () => {
		const f = stubFetch(true)
		const typeInto = vi.fn(async () => undefined)
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page: fakePage({ typeInto }), close: async () => {} }) })
		await tool.call({ op: 'open' }, {} as never)
		const res = await tool.call({ op: 'type', target: 'Message your assistant', text: 'what is this?', submit: true }, {} as never)
		expect(res.isError).toBeFalsy()
		expect(typeInto).toHaveBeenCalledWith('Message your assistant', 'what is this?', true)
		expect(res.content).toContain('pressed Enter')
		const missing = await tool.call({ op: 'type', target: 'x' }, {} as never)
		expect(missing.isError).toBe(true) // no text
		f.mockRestore()
	})
	it('audit FAILS a page that rendered nothing and shows the console error', async () => {
		const f = stubFetch(true)
		const page = fakePage({
			evaluate: async () => ({ pageHeight: 0, steps: [{ y: 0, visible: 0, invisible: 0 }], stuckSamples: [], css: { sheets: 1, bodyFont: 'Geist', bodyBg: 'rgb(255,255,255)' }, textLen: 0 }),
			consoleErrors: () => ['TypeError: o is not a function'],
		})
		const tool = createBrowserTool({ sandbox: fakeSandbox(), launch: async () => ({ page, close: async () => {} }) })
		await tool.call({ op: 'open' }, {} as never)
		const res = await tool.call({ op: 'audit' }, {} as never)
		expect(res.isError).toBe(true)
		expect(res.content).toContain('rendered (almost) nothing')
		expect(res.content).toContain('o is not a function')
		expect(res.content).not.toContain('PASS')
		f.mockRestore()
	})
})
