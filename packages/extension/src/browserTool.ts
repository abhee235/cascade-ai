// browserTool.ts — the extension's Browser tool: the agent LOOKS AT the app it built, in the IDE.
//
// Port of the server's ADR-060/079 Browser tool with the sandbox/preview plumbing removed: in the
// extension there is no managed preview — the model starts its own dev server on the HOST via Bash
// (e.g. `npm run dev`), then opens it here by URL. Same ops (snapshot/screenshot/probe/click/press),
// one addition: op:"audit".
//
// Why audit exists (measured, 2026-07-27): THREE consecutive Orbit builds — web-qwen, hosted Luna, and
// extension-qwen — all shipped scroll-reveal sections permanently stuck at opacity:0 (pricing/specs
// invisible to real visitors). The defect is invisible in code review AND in a top-of-page screenshot;
// it only shows up by scrolling the live page and checking computed styles. audit does exactly that,
// plus console errors — cheap text, no vision needed.

import { z } from 'zod'
import type { Tool } from '@cascade/core'

const inputSchema = z.object({
	op: z
		.enum(['open', 'snapshot', 'screenshot', 'probe', 'click', 'press', 'audit'])
		.describe(
			'open = load a page by URL (do this first) · snapshot = accessibility tree as text (structure — cheap, prefer this) · screenshot = image for VISUAL judgment (expensive — budget these) · probe = evaluate a JS expression in the live page, JSON back (RUNTIME state — games/canvas) · audit = scroll the whole page and report content stuck invisible (opacity 0) + console errors. ALWAYS run audit before declaring a page done.',
		),
	url: z.string().optional().describe('Full URL for op:"open", e.g. "http://localhost:5173". Start the dev server with Bash first. Later opens may pass just `path` to stay on the same origin.'),
	path: z.string().optional().describe('Route to open on the current origin, e.g. "/" or "/settings". Only with op:"open" after a first open with `url`.'),
	expr: z.string().optional().describe('JS expression for op:"probe", evaluated in the page, result JSON-returned. E.g. "__DEBUG__.state()". Canvas/game apps expose window.__DEBUG__.'),
	target: z.string().optional().describe('For op:"click": visible text of the element (e.g. "START GAME") or a CSS selector. For op:"press": a key name, e.g. "ArrowLeft", "Space", "Enter".'),
})

/** Screenshot budget per session — every image is real vision prefill on a local model. */
const MAX_SCREENSHOTS = 8
const SNAPSHOT_MAX_CHARS = 8_000
const PROBE_MAX_CHARS = 4_000

/** Minimal Playwright surface the tool needs — injectable for tests (real impl: playwright-core). */
export interface PageLike {
	goto(url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>
	title(): Promise<string>
	url(): string
	locator(sel: string): { ariaSnapshot(): Promise<string> }
	screenshot(opts: { type: 'jpeg'; quality: number }): Promise<Buffer>
	evaluate(expr: string): Promise<unknown>
	clickText(target: string): Promise<void>
	press(key: string): Promise<void>
	/** Console error lines collected since open (wired by launchPage). */
	consoleErrors(): string[]
}

/** The two ways this tool can be unavailable — module missing, or no browser to drive. Both are the USER's
 *  environment, not something the model can fix, so the message must (a) say what's missing, (b) name the
 *  one-line install, and (c) hand the model a text-only fallback so the turn stays productive instead of
 *  looping on a tool that will never work. */
const UNAVAILABLE_FALLBACK =
	'Continue WITHOUT the browser: verify with Bash instead — `curl -s http://localhost:<port>` for a response, ' +
	'and read the dev-server log for runtime errors. Say clearly in your final answer that you could not visually verify.'

async function launchPage(): Promise<{ page: PageLike; close: () => Promise<void> }> {
	let chromium: typeof import('playwright-core').chromium
	try {
		;({ chromium } = await import('playwright-core'))
	} catch {
		throw new Error(
			`The Browser tool needs the "playwright-core" package, which is not installed in this extension. ` +
				`Install it (npm i playwright-core) and reload the window. ${UNAVAILABLE_FALLBACK}`,
		)
	}
	let browser: import('playwright-core').Browser | undefined
	// System browsers, best-first: Edge ships with Windows; Chrome is the common fallback. Using a CHANNEL
	// means we drive an already-installed browser — no 400MB Playwright download.
	for (const channel of ['msedge', 'chrome']) {
		try {
			browser = await chromium.launch({ channel, headless: true })
			break
		} catch {
			/* channel not installed — try the next */
		}
	}
	// Last resort: a Playwright-managed chromium, if the user ran `npx playwright install`.
	if (!browser) {
		try {
			browser = await chromium.launch({ headless: true })
		} catch {
			/* none downloaded either — fall through to the actionable error */
		}
	}
	if (!browser) {
		throw new Error(
			`No browser found to drive (tried Edge, Chrome, and a Playwright-managed chromium). ` +
				`Install Edge or Chrome, or run \`npx playwright install chromium\`. ${UNAVAILABLE_FALLBACK}`,
		)
	}
	const raw = await browser.newPage({ viewport: { width: 1280, height: 800 } })
	const errors: string[] = []
	raw.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text().slice(0, 300))
	})
	raw.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
	const page = raw as unknown as PageLike
	page.clickText = async (target: string) => {
		const byText = raw.getByText(target, { exact: false }).first()
		if (await byText.count().then((c: number) => c > 0).catch(() => false)) return byText.click({ timeout: 5_000 })
		return raw.locator(target).first().click({ timeout: 5_000 })
	}
	page.press = (key: string) => raw.keyboard.press(key)
	page.consoleErrors = () => errors
	return { page, close: () => browser!.close() }
}

/** The in-page audit: scroll the full page in viewport steps; at each step, count text elements whose own
 *  or ancestor computed opacity is 0 (the stuck scroll-reveal signature) and sample their text. Runs as a
 *  single evaluate so it needs no round-trips. */
const AUDIT_EXPR = `(async () => {
	const H = document.body.scrollHeight, V = window.innerHeight
	const stuck = new Map(), steps = []
	for (let y = 0; y <= H - V + 1; y += Math.max(400, V - 200)) {
		window.scrollTo(0, y)
		await new Promise(r => setTimeout(r, 700))
		let vis = 0, bad = 0
		for (const el of document.querySelectorAll('h1,h2,h3,h4,p,li,a,button')) {
			const r = el.getBoundingClientRect()
			if (r.bottom < 0 || r.top > V || !el.textContent.trim()) continue
			let n = el, hidden = false
			for (let i = 0; i < 5 && n; i++) {
				if (getComputedStyle(n).opacity === '0') { hidden = true; break }
				n = n.parentElement
			}
			if (hidden) { bad++; const t = el.textContent.trim().slice(0, 50); if (stuck.size < 12) stuck.set(t, y) }
			else vis++
		}
		steps.push({ y, visible: vis, invisible: bad })
	}
	window.scrollTo(0, 0)
	return { pageHeight: H, steps, stuckSamples: [...stuck.keys()] }
})()`

/** Build the per-session Browser tool (extension flavor: host dev server, URL-addressed). */
export function createBrowserTool(deps: { launch?: () => Promise<{ page: PageLike; close: () => Promise<void> }> } = {}): Tool {
	let session: { page: PageLike; close: () => Promise<void> } | undefined
	let origin: string | undefined
	let opened = false
	let screenshots = 0

	const tool: Tool<z.infer<typeof inputSchema>> = {
		name: 'Browser',
		description:
			'Look at the RUNNING app in a real browser — verify what you built actually renders and works. Start the dev server with Bash first, then: op:"open" with its URL, op:"snapshot" for the accessibility tree (structure — cheap text, prefer it), op:"screenshot" ONLY for visual judgment (expensive, a few per session), op:"probe" for runtime state of games/canvas (window.__DEBUG__ as JSON). Before declaring the page done, ALWAYS run op:"audit" — it scrolls the whole page and catches content stuck invisible (a scroll-reveal animation that never fires leaves whole sections at opacity 0 — this exact bug shipped three times) plus console errors.',
		inputSchema,
		activitySummary: (input) => `Browser ${input.op}${input.url ? ` ${input.url}` : input.path ? ` ${input.path}` : ''}`,
		isReadOnly: () => true, // looks at the app; never mutates project files
		isConcurrencySafe: () => false, // one page, sequential ops

		async call(input) {
			try {
				if (input.op === 'open') {
					if (input.url) origin = new URL(input.url).origin
					if (!origin) return { content: 'op:"open" needs `url` the first time, e.g. {op:"open", url:"http://localhost:5173"}. Start the dev server with Bash first.', isError: true }
					session ??= await (deps.launch ?? launchPage)()
					const target = input.url ?? origin + (input.path ?? '/')
					await session.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15_000 })
					await new Promise((r) => setTimeout(r, 800)) // let the app paint
					opened = true
					return { content: `Opened ${target} — title: "${await session.page.title()}". Now use op:"snapshot" to check structure, op:"screenshot" to judge the look, and op:"audit" before you call it done.` }
				}

				if (!opened || !session) return { content: 'Nothing is open yet — call Browser {op:"open", url:"http://localhost:<port>"} first.', isError: true }

				if (input.op === 'snapshot') {
					const tree = await session.page.locator('body').ariaSnapshot()
					const cut = tree.length > SNAPSHOT_MAX_CHARS ? `${tree.slice(0, SNAPSHOT_MAX_CHARS)}\n… [truncated]` : tree
					return { content: `Accessibility snapshot of ${session.page.url()}:\n${cut}` }
				}

				if (input.op === 'probe') {
					if (!input.expr?.trim()) return { content: 'op:"probe" needs `expr` — a JS expression, e.g. "__DEBUG__.state()".', isError: true }
					try {
						// Auto-parenthesize a bare object literal: `{a: 1}` evals as a BLOCK STATEMENT and throws.
						const expr = /^\s*\{/.test(input.expr) ? `(${input.expr})` : input.expr
						const result = await session.page.evaluate(expr)
						let json: string
						try {
							json = JSON.stringify(result) ?? 'undefined'
						} catch {
							json = String(result) // circular / non-serializable — degrade to toString
						}
						const cut = json.length > PROBE_MAX_CHARS ? `${json.slice(0, PROBE_MAX_CHARS)}… [truncated]` : json
						return { content: `probe ${input.expr} →\n${cut}` }
					} catch (e) {
						return { content: `probe failed: ${e instanceof Error ? e.message : String(e)}. Is window.__DEBUG__ exposed?`, isError: true }
					}
				}

				if (input.op === 'click') {
					if (!input.target?.trim()) return { content: 'op:"click" needs `target` — visible text (e.g. "START GAME") or a CSS selector.', isError: true }
					await session.page.clickText(input.target)
					await new Promise((r) => setTimeout(r, 300)) // let the app react
					return { content: `Clicked "${input.target}". Use op:"snapshot" or op:"probe" to observe the result.` }
				}
				if (input.op === 'press') {
					if (!input.target?.trim()) return { content: 'op:"press" needs `target` — a key name like "ArrowLeft", "Space", "Enter".', isError: true }
					await session.page.press(input.target)
					await new Promise((r) => setTimeout(r, 150))
					return { content: `Pressed ${input.target}.` }
				}

				if (input.op === 'audit') {
					const report = (await session.page.evaluate(AUDIT_EXPR)) as {
						pageHeight: number
						steps: { y: number; visible: number; invisible: number }[]
						stuckSamples: string[]
					}
					const errs = session.page.consoleErrors()
					const totalStuck = report.steps.reduce((a, s) => a + s.invisible, 0)
					const lines = [
						`Full-page audit of ${session.page.url()} (height ${report.pageHeight}px):`,
						...report.steps.map((s) => `  scroll ${s.y}px → ${s.visible} visible, ${s.invisible} INVISIBLE text elements`),
					]
					if (totalStuck > 0) {
						lines.push(
							`FAIL: ${totalStuck} content elements are stuck at opacity 0 after scrolling — real visitors see blank sections. Usual cause: a scroll-reveal (IntersectionObserver / whileInView) that never fires. Samples: ${report.stuckSamples.map((s) => JSON.stringify(s)).join(', ')}. Fix the reveal (or remove it) and re-run audit.`,
						)
					}
					if (errs.length) lines.push(`Console errors (${errs.length}): ${errs.slice(0, 5).join(' | ')}`)
					if (totalStuck === 0 && errs.length === 0) lines.push('PASS: all content renders while scrolling; no console errors.')
					return { content: lines.join('\n'), isError: totalStuck > 0 }
				}

				// screenshot
				if (screenshots >= MAX_SCREENSHOTS) {
					return { content: `Screenshot budget (${MAX_SCREENSHOTS}) exhausted for this session — use op:"snapshot" (text) for further checks.`, isError: true }
				}
				screenshots++
				const buf = await session.page.screenshot({ type: 'jpeg', quality: 70 })
				return {
					content: `Screenshot of ${session.page.url()} attached (${Math.round(buf.length / 1024)}KB, ${screenshots}/${MAX_SCREENSHOTS}). LOOK at it and name problems concretely, then fix them.`,
					images: [`data:image/jpeg;base64,${buf.toString('base64')}`],
				}
			} catch (e) {
				return { content: `Browser ${input.op} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
			}
		},
	}
	return tool as Tool
}
