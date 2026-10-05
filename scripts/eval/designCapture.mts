// designCapture.mts — capture ONE built app (ADR-085 P0): serve it, walk its views, screenshot and measure each.
// The 2026-09-27 capture (ab-measure.mjs) promoted: same serving, same click flow, same timings for the
// light 1440 px pass — so its numbers stay comparable — plus dark and 390 px passes, and each view marked
// reached or UNREACHABLE (a flow that cannot find its control is reported, never counted as a failure).
// Used by designRescore.mts; the Browser tool's op:'design' (P2) reuses designMetrics.ts, not this file.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright-core'
import { DESIGN_METRICS_EXPR, type CapturedView, type ViewMetrics } from '../../packages/server/src/designMetrics'

export type PassName = 'light-1440' | 'dark-1440' | 'light-390'
export const PASSES: Record<PassName, { width: number; height: number; dark: boolean; suffix: string }> = {
	'light-1440': { width: 1440, height: 900, dark: false, suffix: '' }, // the 09-27 pass — file names unchanged
	'dark-1440': { width: 1440, height: 900, dark: true, suffix: '@dark' },
	'light-390': { width: 390, height: 844, dark: false, suffix: '@390' },
}

export interface CaptureView extends CapturedView {
	/** Where the view OPENED (a view that keeps the previous page's scroll is a UX bug). */
	arrivedScrollY: number
	/** The page's painted background (the deepest full-width opaque one — free designs paint a wrapper, not
	 *  <body>), to tell whether a dark pass actually went dark. */
	pageBg: string
	/** How the flow got here (detail: the kit's media-card, or the free-markup fallback). */
	via?: string
	shot: string
}

export interface AppCapture {
	/** `vite build` exits 0 — the arm-neutral yardstick (the bench check asserts house rules). */
	buildOk: boolean
	served: boolean
	passes: Partial<Record<PassName, CaptureView[]>>
	error?: string
}

// ── Serving: the PRODUCTION build under `vite preview`, never the dev server. Every bench workdir's
// node_modules is a junction to ONE shared tree, and concurrent dev servers race on its .vite optimizer cache
// (measured 09-27: blank captures while a bench ran its own dev servers). A static preview never writes there.
// Ports are PROBED: stale dev servers from earlier runs hold ports in the 5900s.
function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createServer()
		s.once('error', () => resolve(false))
		s.once('listening', () => s.close(() => resolve(true)))
		s.listen(port, '127.0.0.1')
	})
}
export async function freePort(from = 6100): Promise<number> {
	for (let p = from; p < from + 400; p++) if (await portFree(p)) return p
	throw new Error(`no free port in ${from}–${from + 399}`)
}

async function serve(workdir: string, port: number): Promise<{ buildOk: boolean; proc: ChildProcess; up: boolean }> {
	const vite = join(workdir, 'node_modules', 'vite', 'bin', 'vite.js')
	const build = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'error'], { cwd: workdir, stdio: 'ignore', timeout: 240_000 })
	const proc = spawn(process.execPath, [vite, 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: workdir, stdio: 'ignore' })
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { buildOk: build.status === 0, proc, up: true }
		} catch {
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, 500))
	}
	return { buildOk: build.status === 0, proc, up: false }
}

// ── Flows. Kept here for P0; P2 moves them into skills/builder/{commerce,landing}/contract.json, where the
// builder can read the accessible names the probe uses. The shop flow is the 09-27 heuristic VERBATIM.
type Step = { view: string; go?: (page: Page) => Promise<{ found: boolean; via?: string } | null> }

const click = async (loc: Locator): Promise<boolean> => {
	if (!(await loc.count())) return false
	await loc.first().click({ timeout: 5000 }).catch(() => {})
	await loc.page().waitForTimeout(1200)
	return true
}

/** Open a PRODUCT whatever the markup: the kit's MediaCard; else walk up from the first "Add to cart" to its
 *  card and click that card's own link/button (the name or image) — not the first image on the page, which
 *  in a free design is often a non-clickable hero photo. */
async function openProduct(page: Page): Promise<{ found: boolean; via?: string }> {
	if (await click(page.locator('[data-block="media-card"]'))) return { found: true, via: 'media-card' }
	await page.evaluate(() => {
		const add = [...document.querySelectorAll('button')].find((b) => /add to (cart|bag)/i.test(b.textContent ?? ''))
		let card = add?.parentElement
		while (card && !card.querySelector('img')) card = card.parentElement
		const target =
			[...(card?.querySelectorAll('a, button, [role="button"]') ?? [])].find((e) => !/add to (cart|bag)/i.test(e.textContent ?? '')) ??
			card?.querySelector('img') ??
			document.querySelector('main :is(a, button, [role="button"]):has(img)') ??
			document.querySelector(':is(a, button, [role="button"]):has(img)')
		target?.setAttribute('data-ab-target', '1')
	})
	return { found: await click(page.locator('[data-ab-target="1"]')), via: 'fallback' }
}

export const FLOWS: Record<string, Step[]> = {
	'builder-shop': [
		{ view: '1-catalog' },
		{ view: '2-detail', go: openProduct },
		{
			view: '3-cart',
			go: async (page) => {
				await click(page.getByRole('button', { name: /add to (cart|bag)/i }))
				const cart = page.getByRole('button', { name: /^(?!.*add).*(cart|bag)/i }).or(page.getByRole('link', { name: /^(?!.*add).*(cart|bag)/i }))
				return { found: await click(cart) }
			},
		},
		// Snapped only when a Checkout control exists (09-27 semantics) — `null` = skip the view entirely.
		{ view: '4-checkout', go: async (page) => ((await click(page.getByRole('button', { name: /checkout/i }))) ? { found: true } : null) },
	],
	default: [{ view: '1-page' }],
}

/** What a view LOOKS like, to tell "the click did nothing" from "the click navigated". */
const signature = (page: Page) => page.evaluate(() => `${location.href}|${document.body.innerText.length}|${document.querySelector('h1')?.textContent ?? ''}`)

const pageBackground = (page: Page) =>
	page.evaluate(() => {
		const clear = /^(?:transparent|rgba\(0, 0, 0, 0\))$/
		let bg = 'rgba(0, 0, 0, 0)'
		// A PAGE layer is wide AND tall: the ADR-086 image probe's first #root child was a 40 px shipping strip in a
		// hard-coded green, read as "the page" in both passes — its dark pass (which did go dark) scored as light.
		for (const el of [document.documentElement, document.body, document.getElementById('root'), ...document.querySelectorAll('#root > *'), document.querySelector('main')]) {
			if (!el) continue
			const s = getComputedStyle(el).backgroundColor
			const r = el.getBoundingClientRect()
			if (!clear.test(s) && r.width >= innerWidth * 0.5 && r.height >= innerHeight * 0.5) bg = s // deeper opaque layers win
		}
		return bg
	})

/** One pass over one app: a fresh context (clean storage — no cart carried between passes). A failure mid-pass
 *  keeps the views already captured and names the failure. */
async function runPass(browser: Browser, url: string, scenario: string, pass: PassName, shotBase: string): Promise<{ views: CaptureView[]; error?: string }> {
	const cfg = PASSES[pass]
	const context = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, colorScheme: cfg.dark ? 'dark' : 'light' })
	const page = await context.newPage()
	const errors: string[] = []
	page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200))) // a build can pass and still crash here
	// Dark = both switches: the template's `.dark` class (its toggle) and the media query (free designs).
	const darken = () => (cfg.dark ? page.evaluate(() => document.documentElement.classList.add('dark')).catch(() => {}) : Promise.resolve())
	const views: CaptureView[] = []
	try {
		// networkidle as on 09-27; a page whose network never idles (a slow image host) falls back to `load`.
		await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => page.waitForLoadState('load'))
		await darken()
		await page.waitForTimeout(1500)
		// Scroll through once so scroll-reveal sections fire before any capture (09-27 behavior).
		await page.evaluate(async () => {
			for (let y = 0; y < document.body.scrollHeight; y += 600) {
				window.scrollTo(0, y)
				await new Promise((r) => setTimeout(r, 120))
			}
			window.scrollTo(0, 0)
		})
		for (const step of FLOWS[scenario] ?? FLOWS.default!) {
			let reached = true
			let via: string | undefined
			if (step.go) {
				const before = await signature(page)
				const res = await step.go(page)
				if (res === null) continue
				via = res.via
				reached = res.found && (await signature(page)) !== before
			}
			await darken()
			const arrivedScrollY = await page.evaluate(() => Math.round(window.scrollY))
			await page.evaluate(() => window.scrollTo(0, 0))
			await page.waitForTimeout(400)
			const shot = `${shotBase}-${step.view}${cfg.suffix}.png`
			await page.screenshot({ path: shot, fullPage: true })
			// The 09-27 fields are read right here — after the full-page screenshot, before anything scrolls.
			const metrics = (await page.evaluate(DESIGN_METRICS_EXPR)) as ViewMetrics
			views.push({ name: step.view, reached, via, errors: errors.splice(0), metrics, arrivedScrollY, pageBg: await pageBackground(page), shot })
		}
		return { views }
	} catch (e) {
		return { views, error: String(e instanceof Error ? e.message : e).split('\n')[0]!.slice(0, 200) }
	} finally {
		await context.close()
	}
}

/** Build, serve and walk one app through the requested passes. Never throws — failures land in `error`. */
export async function captureApp(opts: { workdir: string; scenario: string; outDir: string; tag: string; browser: Browser; passes?: PassName[] }): Promise<AppCapture> {
	mkdirSync(opts.outDir, { recursive: true })
	const port = await freePort()
	const server = await serve(opts.workdir, port)
	const result: AppCapture = { buildOk: server.buildOk, served: server.up, passes: {} }
	try {
		// A failed build leaves an OLD dist/ behind — capturing it would score a different app.
		if (!server.buildOk) throw new Error('vite build failed — nothing current to capture')
		if (!server.up) throw new Error(`vite preview never answered on :${port}`)
		const errors: string[] = []
		for (const pass of opts.passes ?? (Object.keys(PASSES) as PassName[])) {
			const run = await runPass(opts.browser, `http://127.0.0.1:${port}/`, opts.scenario, pass, join(opts.outDir, opts.tag))
			result.passes[pass] = run.views
			if (run.error) errors.push(`${pass}: ${run.error}`)
		}
		if (errors.length) result.error = errors.join(' | ')
	} catch (e) {
		result.error = String(e instanceof Error ? e.message : e).slice(0, 200)
	} finally {
		server.proc.kill()
	}
	return result
}
