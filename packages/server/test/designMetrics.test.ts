import { describe, it, expect, afterAll } from 'vitest'
import { chromeDrift, DESIGN_METRICS_EXPR, hardFindings, viewStatus, type CapturedView, type ViewMetrics } from '../src/designMetrics'

// ADR-085 P0: the in-page half of the design instrument. The pure aggregation is tested directly; the
// expression runs in a real Chromium against a fixture page whose every case has a known answer (skipped
// where no browser is installed — the desktop bundles one, a checkout uses Edge/Chrome or Playwright's).

const metrics = (over: Partial<ViewMetrics> = {}): ViewMetrics => ({
	textChars: 500, footers: 1, headers: 1, contentLeft: 100, contentRight: 1300, h1px: 48, h2px: 30, pageHeight: 2000,
	blank: false, chrome: { header: { left: 100, right: 1340 }, footer: { left: 100, right: 1340 } },
	images: { total: 3, broken: 0, brokenSrc: [] }, overflow: { x: 0, count: 0, samples: [] },
	contrast: { checked: 40, unknown: {}, unmeasured: 0, fail: 0, invisible: 0, invisibleInteractive: 0, worst: [] },
	viewport: { w: 1440, h: 900 }, dark: false, ...over,
})

describe('design metrics — aggregation', () => {
	it('HARD findings are only the objective classes; an unreachable view is reported, never failed', () => {
		const view = (over: Partial<CapturedView>): CapturedView => ({ name: 'v', reached: true, errors: [], metrics: metrics(), ...over })
		expect(viewStatus(view({}))).toBe('pass')
		expect(viewStatus(view({ reached: false, errors: ['boom'] }))).toBe('unreachable')
		expect(hardFindings(view({ errors: ['r is not a function'] }))).toEqual(['runtime error: r is not a function']) // arm 5's detail page
		expect(hardFindings(view({ metrics: metrics({ blank: true }) }))).toEqual(['blank view'])
		expect(hardFindings(view({ metrics: metrics({ images: { total: 2, broken: 1, brokenSrc: ['https://x/a.jpg'] } }) }))).toEqual(['1 broken image: https://x/a.jpg'])
		const c = metrics().contrast
		expect(hardFindings(view({ metrics: metrics({ contrast: { ...c, fail: 9, invisible: 3, invisibleInteractive: 0 } }) }))).toEqual([]) // SOFT until proven
		expect(hardFindings(view({ metrics: metrics({ contrast: { ...c, invisible: 1, invisibleInteractive: 1 } }) }))).toEqual(['1 invisible button/link label (<1.5:1)'])
	})

	it('chrome drift is the largest movement of any header/footer edge across views', () => {
		const at = (hl: number, fr: number) => metrics({ chrome: { header: { left: hl, right: 1340 }, footer: { left: 100, right: fr } } })
		expect(chromeDrift([at(100, 1340), at(100, 1340)])).toBe(0)
		expect(chromeDrift([at(100, 1340), at(168, 1340), at(120, 1300)])).toBe(68)
		expect(chromeDrift([metrics({ chrome: { header: null, footer: null } }), at(100, 1340)])).toBeNull()
	})
})

// ── The expression in a real browser ────────────────────────────────────────────────────────────────────
type Browser = import('playwright-core').Browser
async function launch(): Promise<Browser | undefined> {
	const { chromium } = await import('playwright-core')
	for (const opts of [{}, { channel: 'msedge' }, { channel: 'chrome' }]) {
		try {
			return await chromium.launch({ headless: true, ...opts })
		} catch {
			/* not installed — next */
		}
	}
	return undefined
}
const browser = await launch()
afterAll(() => browser?.close())

const PHOTO = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#222"/></svg>')
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const FIXTURE = `<!doctype html><html><head><style>
	body { margin: 0; font: 16px/1.5 sans-serif; background: #fff; color: #111 }
	header { position: sticky; top: 0; display: flex; justify-content: space-between; padding: 16px 100px; background: #fff }
	.band { background: oklch(0.48 0.19 292); color: #fff; padding: 40px 100px }
	.outline { background: #fff; color: #fff; border: 1px solid #fff }
	.hero { position: relative; height: 300px; color: #fff }
	.hero img { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none }
	.hero h1 { position: relative; margin: 0; padding: 40px 100px }
	.grad-text { background: linear-gradient(90deg, #f0f, #0ff); -webkit-background-clip: text; background-clip: text; color: transparent }
	.grad-band { background: linear-gradient(#1e1b4b, #312e81); color: #fff; padding: 20px 100px }
	.muted { color: #767676 } .faint { color: #999 }
	.fading { opacity: 0.1 }
	.below { margin-top: 2400px; color: #eee }
	.drawer { position: fixed; top: 0; left: 100vw; width: 300px; height: 100px; background: #eee }
	.scroller { overflow-x: auto } .scroller div { width: 1200px }
	.wide { width: 600px }
	footer { padding: 16px 100px }
</style></head><body>
	<header><b>Shop</b><nav><a href="/a">Catalog</a> <a href="/b">Cart</a></nav></header>
	<main>
		<section class="band"><p>On the band</p><button class="outline">Get started</button></section>
		<section class="hero"><img src="${PHOTO}" alt=""><h1>White over a dark photo</h1></section>
		<h2 class="grad-text">Gradient headline</h2>
		<section class="grad-band"><p>White on an indigo gradient</p></section>
		<p class="muted">AA gray on white</p><p class="faint">Too faint</p>
		<p>Ships in 2 days <span style="color:#fafafa">·</span> Free returns</p>
		<div class="fading"><p>Revealing</p></div>
		<button disabled style="color:#ddd;background:#fff">Disabled</button>
		<img src="/does-not-exist.png" alt="broken" width="80" height="80"><img src="" alt="" style="width:80px;height:80px"><img src="${PIXEL}" alt="ok" width="10" height="10">
		<div class="scroller"><div>wide but contained</div></div>
		<div class="wide">wider than a phone</div>
		<p class="below">Almost white, far below the fold</p>
	</main>
	<div class="drawer">closed drawer</div>
	<footer><span>© Shop</span></footer>
</body></html>`

describe.runIf(!!browser)('design metrics — in a real page', () => {
	const run = async (html: string, viewport = { width: 1440, height: 900 }) => {
		const page = await browser!.newPage({ viewport })
		try {
			await page.setContent(html, { waitUntil: 'load' })
			return (await page.evaluate(DESIGN_METRICS_EXPR)) as ViewMetrics
		} finally {
			await page.close()
		}
	}

	it('measures contrast against the painted background, and says "unknown" rather than guess', async () => {
		const m = await run(FIXTURE)
		expect(m.errors).toBeUndefined()
		// White text over a photo (pointer-events:none on the img, forced back on) — never "white on white".
		expect(m.contrast.unknown).toMatchObject({ 'over-media': 1, 'gradient-text': 1, fading: 1, disabled: 1 })
		expect(m.contrast.invisibleInteractive).toBe(1) // the white-on-white outline CTA on a colored band (arm 6)
		expect(m.contrast.invisible).toBe(2) // + the almost-white paragraph the sweep found far below the fold
		expect(m.contrast.fail).toBe(3)
		expect(m.contrast.worst.map((w) => [w.text, w.kind])).toEqual([['Get started', 'button'], ['Almost white, far below the fold', 'text'], ['Too faint', 'text']])
		expect(m.contrast.worst[2]).toMatchObject({ ratio: 2.85, fg: '#999999', bg: '#ffffff' })
		expect(m.contrast.unmeasured).toBe(1) // the closed off-canvas drawer never enters the viewport
	})

	it('reports chrome edges, broken images and the 09-27 fields', async () => {
		const m = await run(FIXTURE)
		expect(m.chrome.header).toEqual({ left: 100, right: 1340 })
		expect(m.chrome.footer?.left).toBe(100)
		expect(m.images).toMatchObject({ total: 4, broken: 2 }) // a 404 and an empty src that still takes space
		expect(m.images.brokenSrc).toContain('(empty src)')
		expect([m.headers, m.footers, m.blank]).toEqual([1, 1, false])
		expect(m.overflow.count).toBe(0) // the fixed drawer past the right edge is not page overflow
	})

	it('finds 390 px overflow, ignoring fixed layers and scroll containers', async () => {
		const m = await run(FIXTURE, { width: 390, height: 844 })
		expect(m.overflow.count).toBe(1)
		expect(m.overflow.samples[0]).toBe('div.wide +210px')
		expect(m.overflow.x).toBe(210)
	})

	it('finds the site chrome by geometry — the whole page wrapped in <main>, a card <header> ignored — and a cart badge is not drift', async () => {
		// Measured 09-27: Luna and Qwen landings wrap everything in <main>; a cart badge moved the last header
		// icon 36 px on every template shop. Neither is the page jumping.
		const page = (cart: string) => `<!doctype html><html><body style="margin:0;font:16px sans-serif"><main>
			<header><div style="max-width:1000px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between"><b>Shop</b><button>${cart}</button></div></header>
			<article style="width:300px"><header>Card title</header><p>Card body</p></article>
			<footer><div style="max-width:1000px;margin:0 auto;padding:0 24px"><span>© Shop</span></div></footer>
		</main></body></html>`
		const [a, b] = [await run(page('Cart')), await run(page('Cart (3 items)'))]
		// content-box sizing here (no preflight): max-width bounds the CONTENT, which is what the edges report.
		expect(a.chrome).toEqual({ header: { left: 220, right: 1220 }, footer: { left: 220, right: 1220 } })
		expect(chromeDrift([a, b])).toBe(0)
	})

	it('composites a gradient over its OWN background-color, not the page beneath (ADR-086 P0 false "invisible")', async () => {
		// The image probe's hero: light text on a green panel whose gradients fade to transparent. The panel's color
		// sits under its own gradients; the page's mint must never show through.
		const m = await run(`<!doctype html><html><body style="margin:0;background:#ecfbf5;font:18px sans-serif">
			<div style="padding:40px;background:radial-gradient(circle, rgba(0,184,132,.18), transparent 40%), #064e3b">
				<p style="color:#ecfbf5">Everyday goods, made to last.</p>
			</div></body></html>`)
		expect(m.contrast.checked).toBe(1)
		expect([m.contrast.fail, m.contrast.invisible]).toEqual([0, 0])
	})

	it('measures the rhythm content to content — a colored band or a bordered footer counts from its edge', async () => {
		// Three plain sections, 80 px padding each (160 px between their contents), then a gray band (its edge is
		// 80 px below the last content) and a bordered footer flush under it (touching: adjacency, not rhythm).
		const sec = (t: string, bg = '') => `<section style="padding:80px 0;${bg}"><div style="height:100px">${t}</div></section>`
		const m = await run(`<!doctype html><html><body style="margin:0;font:16px sans-serif">
			<header style="height:60px"><b>Brand</b></header>
			<main>${sec('One')}${sec('Two')}${sec('Three')}${sec('Band', 'background:#eeeeee')}</main>
			<footer style="border-top:1px solid #ddd;padding:40px 0">© Brand</footer></body></html>`)
		expect(m.rhythm).toEqual({ bands: 5, gaps: [160, 160, 80, 0], compact: [], ratio: 2 })
	})

	it('returns the full rhythm shape on a page with no flow (one centered card) — `compact` included', async () => {
		// Review (2026-10-04): the no-flow early return dropped `compact`, which the ViewMetrics type promises.
		const m = await run(`<!doctype html><html><body style="margin:0;font:16px sans-serif">
			<div style="width:320px;margin:120px auto;padding:24px;border:1px solid #ddd">Sign in</div></body></html>`)
		expect(m.rhythm).toEqual({ bands: 0, gaps: [], compact: [], ratio: null })
	})

	it('reports the gaps beside a band DECLARED thin apart from the rhythm — an intended second step', async () => {
		// The template's <Section compact> (a logo row under the hero) sits close by design and says so.
		const m = await run(`<!doctype html><html><body style="margin:0;font:16px sans-serif"><main>
			<section style="padding:80px 0 0"><div style="height:200px">Hero</div></section>
			<section data-compact style="padding:40px 0 0"><div style="height:40px">Northwind · Kestrel</div></section>
			<section style="padding:80px 0"><div style="height:100px">Features</div></section>
			<section style="padding:0 0 80px"><div style="height:100px">Pricing</div></section></main></body></html>`)
		expect(m.rhythm).toMatchObject({ gaps: [40, 80, 80], compact: [40, 80], ratio: null })
	})

	it('names the brand mark: a bare stock icon, a monogram, a symbol in a shape, a wordmark', async () => {
		const header = (brand: string) => `<!doctype html><html><body style="margin:0;font:16px sans-serif"><header style="display:flex;justify-content:space-between;padding:16px 24px">
			<a href="/" style="display:flex;align-items:center;gap:8px">${brand}</a><nav><a href="/a">Shop</a> <a href="/b">About</a></nav></header><main><p>Body</p></main></body></html>`
		const icon = '<svg class="lucide lucide-store" width="16" height="16" viewBox="0 0 24 24"><rect width="24" height="24"/></svg>Cascade Shop'
		const mono = '<span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:#1d4ed8;color:#fff">C</span>Cascade Shop'
		const symbol = '<span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:#064e3b"><i style="display:block;width:16px;height:4px;background:#4ce0a8"></i></span>Cascade Shop'
		expect((await run(header(icon))).logo).toEqual({ kind: 'icon', height: 16, text: 'Cascade Shop' })
		expect((await run(header(mono))).logo).toMatchObject({ kind: 'monogram', height: 36 })
		expect((await run(header(symbol))).logo).toMatchObject({ kind: 'symbol', height: 36 })
		expect((await run(header('<span style="font-size:22px;font-weight:800">Ferrite</span>'))).logo).toMatchObject({ kind: 'wordmark', text: 'Ferrite' })
	})

	it('calls an empty React root blank', async () => {
		const m = await run('<!doctype html><html><body><div id="root"></div></body></html>')
		expect([m.blank, m.textChars, m.contrast.checked]).toEqual([true, 0, 0])
	})
})
