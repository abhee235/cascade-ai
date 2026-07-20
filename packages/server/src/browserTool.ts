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
	op: z.enum(['open', 'snapshot', 'screenshot']).describe('open = load the app (do this first) · snapshot = accessibility tree as text (structure — cheap, prefer this) · screenshot = image for VISUAL judgment (expensive — budget these).'),
	path: z.string().optional().describe('Route to open, e.g. "/" or "/settings". Only with op:"open"; the app origin is fixed.'),
})

/** Where the dev server writes its log inside the container (same file PreviewManager tails). */
const DEV_LOG = '/tmp/cascade-dev.log'
/** Screenshot budget per session — every image is real vision prefill on a local model. */
const MAX_SCREENSHOTS = 8
const SNAPSHOT_MAX_CHARS = 8_000

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
}

async function launchPage(): Promise<{ page: PageLike; close: () => Promise<void> }> {
	const { chromium } = await import('playwright-core')
	let browser: import('playwright-core').Browser | undefined
	// System browsers, best-first: Edge ships with Windows; Chrome is the common fallback.
	for (const channel of ['msedge', 'chrome']) {
		try {
			browser = await chromium.launch({ channel, headless: true })
			break
		} catch {
			/* channel not installed — try the next */
		}
	}
	if (!browser) throw new Error('No system browser found (tried Edge, Chrome). Install one, or skip browser checks.')
	const page = (await browser.newPage({ viewport: { width: 1280, height: 800 } })) as unknown as PageLike
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
			'Look at the RUNNING app in a real browser — verify what you built actually renders and works. Use AFTER `npm run build` passes: op:"open" first (starts/loads the live preview), then op:"snapshot" for the accessibility tree (structure: headings, buttons, empty states — cheap text, prefer it), and op:"screenshot" ONLY for visual judgment (colors, layout, imagery — expensive, a few per session). Judge screenshots against the design checklist and FIX what you see.',
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
