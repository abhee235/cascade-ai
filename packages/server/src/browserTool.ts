// browserTool.ts — the vision-gated Browser tool (ADR-060 Phase 1, read-only): the agent LOOKS AT the app
// it built. The observed loop (agent-browser skill: open → a11y snapshot → screenshot → visual judgment)
// rebuilt for our architecture: Playwright runs headless ON THE HOST against the project's published
// preview port (the sandbox container has no browser), and screenshots return as data-URI images the loop
// lifts into vision blocks (Tool.images → ADR-060 core plumbing). Injected per-session via
// `extraTools` ONLY when the model reports `vision` (modelCaps.ts) — non-vision models never see it.
//
// playwright-core + the system browser channel (msedge/chrome): no 400MB browser download at install.
// Probe verdict (2026-07-20): qwen36-agentic read every recipe title off a screenshot, named the palette
// and serif/sans mix, and found three REAL design defects (repeated/mismatched photos, badge drift).

import { z } from 'zod'
import type { Tool } from '@cascade/core'
import type { DockerSandbox } from './dockerSandbox.js'

const inputSchema = z.object({
	op: z.enum(['open', 'snapshot', 'screenshot', 'probe', 'click', 'press', 'audit']).describe('open = load the app (do this first) · snapshot = accessibility tree as text (structure — cheap, prefer this) · screenshot = image for VISUAL judgment (expensive — budget these) · probe = evaluate a JS expression in the live page and get JSON back (RUNTIME state — games/canvas/dynamic behavior that snapshots cannot see) · audit = scroll the WHOLE page and report content stuck invisible (opacity 0) + console errors. ALWAYS run audit before declaring the page done.'),
	path: z.string().optional().describe('Route to open, e.g. "/" or "/settings". Only with op:"open"; the app origin is fixed.'),
	expr: z.string().optional().describe('JS expression for op:"probe", evaluated in the page, result JSON-returned. E.g. "__DEBUG__.state()" or "(__DEBUG__.step(60), __DEBUG__.state().ball)". Canvas/game apps expose window.__DEBUG__ (see the game-dev skill).'),
	target: z.string().optional().describe('For op:"click": visible text of the element (e.g. "START GAME") or a CSS selector. For op:"press": a key name, e.g. "ArrowLeft", "Space", "Enter", "Escape".'),
})

/** Where the dev server writes its log inside the container (same file PreviewManager tails). */
const DEV_LOG = '/tmp/cascade-dev.log'
/** Screenshot budget per session — every image is real vision prefill on a local model. */
const MAX_SCREENSHOTS = 8
const SNAPSHOT_MAX_CHARS = 8_000
const PROBE_MAX_CHARS = 4_000

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url, { signal: AbortSignal.timeout(2000) })
			return true
		} catch {
			await new Promise((r) => setTimeout(r, 1000))
		}
	}
	return false
}

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
	/** Console error lines collected since open (wired by launchPage; optional for test fakes). */
	consoleErrors?(): string[]
}

/** The in-page audit (measured, 2026-07-27: THREE consecutive Orbit builds shipped scroll-reveal sections
 *  permanently stuck at opacity:0 — invisible in code review and in top-of-page screenshots). Scroll the
 *  full page in viewport steps; at each step count text elements whose own/ancestor computed opacity is 0
 *  and sample their text. One evaluate call — no round-trips. */
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

async function launchPage(): Promise<{ page: PageLike; close: () => Promise<void> }> {
	const { chromium } = await import('playwright-core')
	let browser: import('playwright-core').Browser | undefined

	// 1. The SHIPPED browser, when there is one (ADR-081 §7 — the desktop bundles a headless Chromium and
	//    points PLAYWRIGHT_BROWSERS_PATH at it). Preferred because its revision is pinned to this exact
	//    playwright-core: a mismatched pair fails with "Executable doesn't exist", and a browser the user
	//    happens to have is a version we have never tested against.
	if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
		try {
			browser = await chromium.launch({ headless: true })
		} catch {
			/* not shipped in this build, or the revision is wrong — fall through to the system browsers */
		}
	}

	// 2. System browsers, best-first: Edge ships with Windows; Chrome is the common fallback. This is what
	//    a `npm run dev` checkout uses, and it keeps the source install free of a 270MB download.
	if (!browser) {
		for (const channel of ['msedge', 'chrome']) {
			try {
				browser = await chromium.launch({ channel, headless: true })
				break
			} catch {
				/* channel not installed — try the next */
			}
		}
	}
	if (!browser) throw new Error('No browser available (tried the bundled Chromium, then Edge and Chrome). Install Edge or Chrome, or skip browser checks.')
	const raw = await browser.newPage({ viewport: { width: 1280, height: 800 } })
	const errors: string[] = []
	raw.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text().slice(0, 300))
	})
	raw.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
	const page = raw as unknown as PageLike
	// The interactive ops (ADR-079 Phase 0 — the missing HANDS: the gametester couldn't click START GAME).
	// click accepts visible text first (what a model naturally quotes), CSS selector as the fallback.
	page.clickText = async (target: string) => {
		const byText = raw.getByText(target, { exact: false }).first()
		if (await byText.count().then((c: number) => c > 0).catch(() => false)) return byText.click({ timeout: 5_000 })
		return raw.locator(target).first().click({ timeout: 5_000 })
	}
	page.press = (key: string) => raw.keyboard.press(key)
	page.consoleErrors = () => errors
	return { page, close: () => browser!.close() }
}

export interface BrowserToolDeps {
	/** The project's sandbox — used to resolve the published preview port and to start the dev server. */
	sandbox: DockerSandbox
	/** Test seam: replace the real Playwright launch. */
	launch?: () => Promise<{ page: PageLike; close: () => Promise<void> }>
}

/** Build the per-session Browser tool. One lazy page per session, closed via [Symbol.asyncDispose]-less
 *  best-effort (the process-level browser closes with the server; sessions are long-lived anyway). */
export function createBrowserTool(deps: BrowserToolDeps): Tool {
	let session: { page: PageLike; close: () => Promise<void> } | undefined
	let opened = false
	let screenshots = 0

	const tool: Tool<z.infer<typeof inputSchema>> = {
		name: 'Browser',
		description:
			'Look at the RUNNING app in a real browser — verify what you built actually renders and works. Use AFTER `npm run build` passes: op:"open" first (starts/loads the live preview), then op:"snapshot" for the accessibility tree (structure: headings, buttons, empty states — cheap text, prefer it), and op:"screenshot" ONLY for visual judgment (colors, layout, imagery — expensive, a few per session). Judge screenshots against the design checklist and FIX what you see. For GAMES/canvas/dynamic behavior use op:"probe" — snapshots cannot see a canvas; probe reads the RUNTIME state (window.__DEBUG__) as JSON so you tune with numbers, not guesses. Before declaring the page done, ALWAYS run op:"audit" — it scrolls the whole page and catches content stuck invisible (a scroll-reveal that never fires leaves sections at opacity 0) plus console errors.',
		inputSchema,
		activitySummary: (input) => `Browser ${input.op}${input.path ? ` ${input.path}` : ''}`,
		isReadOnly: () => true, // looks at the app; never mutates project files
		isConcurrencySafe: () => false, // one page, sequential ops

		async call(input) {
			try {
				const port = await deps.sandbox.getHostPort()
				const origin = `http://localhost:${port}`

				if (input.op === 'open') {
					// The dev server may not be running (the user hasn't opened the Preview pane). Start it the
					// same way PreviewManager does — detached, logged — and wait for the port. Idempotent: if
					// it's already up, the port answers before the exec matters.
					if (!(await waitForHttp(origin, 3_000))) {
						// ADR-066: reap any stale dev/API process from a prior submit before starting a fresh one.
						await deps.sandbox.exec('pkill -f "vite" ; pkill -f "tsx.*server" ; true').catch(() => {})
						await deps.sandbox.execDetached(`CHOKIDAR_USEPOLLING=true npm run dev > ${DEV_LOG} 2>&1`)
						if (!(await waitForHttp(origin, 30_000))) {
							return { content: `The dev server did not answer on ${origin} within 30s. Run \`npm run dev\` with Bash, check its output for errors, then try Browser open again.`, isError: true }
						}
					}
					session ??= await (deps.launch ?? launchPage)()
					await session.page.goto(origin + (input.path ?? '/'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
					await new Promise((r) => setTimeout(r, 800)) // let the app paint
					opened = true
					return { content: `Opened ${input.path ?? '/'} — title: "${await session.page.title()}". Now use op:"snapshot" to check structure, or op:"screenshot" to judge the look.` }
				}

				if (!opened || !session) return { content: 'Nothing is open yet — call Browser {op:"open"} first.', isError: true }

				if (input.op === 'snapshot') {
					const tree = await session.page.locator('body').ariaSnapshot()
					const cut = tree.length > SNAPSHOT_MAX_CHARS ? `${tree.slice(0, SNAPSHOT_MAX_CHARS)}\n… [truncated]` : tree
					return { content: `Accessibility snapshot of ${session.page.url()}:\n${cut}` }
				}

				if (input.op === 'probe') {
					// ADR-079: the game-feedback channel. A <canvas> is INVISIBLE to accessibility snapshots and a
					// screenshot is one static frame — measured (Neon Breaker build): 17 Browser calls produced zero
					// gameplay signal while the model tuned "feel" blind (shipped a projectile 3× too fast). Probe
					// turns runtime behavior into DATA: evaluate an expression (the game-dev skill mandates a
					// window.__DEBUG__ contract: state()/events/step(n)/seed()) and reason about numbers instead.
					if (!input.expr?.trim()) return { content: 'op:"probe" needs `expr` — a JS expression, e.g. "__DEBUG__.state()".', isError: true }
					try {
						// Auto-parenthesize a bare object literal: `{a: 1}` evals as a BLOCK STATEMENT and throws
						// "Unexpected token ':'" (measured: the model's very first probe failed exactly this way).
						const expr = /^\s*\{/.test(input.expr) ? `(${input.expr})` : input.expr
						const result = await session.page.evaluate(expr)
						let json: string
						try {
							json = JSON.stringify(result) ?? 'undefined'
						} catch {
							json = String(result) // circular / non-serializable — degrade to toString
						}
						const cut = json.length > PROBE_MAX_CHARS ? `${json.slice(0, PROBE_MAX_CHARS)}… [truncated]` : json
						return { content: `probe ${input.expr} →
${cut}` }
					} catch (e) {
						return { content: `probe failed: ${e instanceof Error ? e.message : String(e)}. Is window.__DEBUG__ exposed? (The game-dev skill requires it before gameplay code.)`, isError: true }
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
					const errs = session.page.consoleErrors?.() ?? []
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
					content: `Screenshot of ${session.page.url()} attached (${Math.round(buf.length / 1024)}KB, ${screenshots}/${MAX_SCREENSHOTS}). LOOK at it: does the page match the design checklist (blocks composed, token colors, real imagery, one primary CTA)? Name problems concretely and fix them.`,
					images: [`data:image/jpeg;base64,${buf.toString('base64')}`],
				}
			} catch (e) {
				return { content: `Browser ${input.op} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
			}
		},
	}
	return tool as Tool
}
