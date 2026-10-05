// designMetrics.ts — the IN-PAGE half of the design instrument (ADR-085 P0; designChecks.ts is the source
// half). One expression, evaluated per view after the view is captured, returns everything the bench and —
// from P2 — the Browser tool's op:'design' and the post-turn check need. A STRING, like browserTool's
// AUDIT_EXPR: a serialized TS function breaks under esbuild's injected __name helper, a string cannot.
//
// The first block recomputes the 2026-09-27 capture's fields EXACTLY (same selectors, same moment — after the
// full-page screenshot, before anything scrolls), so the rescore can prove it measures what that run measured.
// Everything after it is new: chrome edges, broken images, overflow, and contrast against the background the
// text is REALLY painted on (a naive ancestor walk calls white hero text over a photo "white on white").

/** Content edges (px) of a chrome element's visible text and media — the logo's left, the last icon's right. */
export interface ChromeEdges {
	left: number
	right: number
}

export interface ContrastSample {
	text: string
	kind: 'text' | 'link' | 'button'
	ratio: number
	fg: string
	bg: string
}

export interface ViewMetrics {
	// The 09-27 fields (ab-measure's domMetrics, verbatim semantics).
	textChars: number
	footers: number
	headers: number
	contentLeft: number | null
	contentRight: number | null
	h1px: number
	h2px: number
	pageHeight: number
	// New.
	/** Nothing to see: under 40 characters of text and no sizeable media once the page has loaded. */
	blank: boolean
	/** The site header/footer (not a card's <header>). Drift across views = the page "jumping". */
	chrome: { header: ChromeEdges | null; footer: ChromeEdges | null }
	images: { total: number; broken: number; brokenSrc: string[] }
	/** Horizontal page overflow at this viewport: px past the edge, and the outermost offenders. */
	overflow: { x: number; count: number; samples: string[] }
	contrast: {
		checked: number
		/** Not computable, by reason: text over a photo/video, gradient text, covered, fading. */
		unknown: Record<string, number>
		/** Text that never scrolled into view (e.g. inside a closed horizontal scroller). */
		unmeasured: number
		/** Below WCAG AA (4.5:1, or 3:1 for large text), measured against the WORST gradient stop. */
		fail: number
		/** Under 1.5:1 even against the best stop — invisible. HARD when the text is a button or link. */
		invisible: number
		invisibleInteractive: number
		worst: ContrastSample[]
	}
	viewport: { w: number; h: number }
	/** ADR-086 P1: the gaps (px) between the page's consecutive bands, content to content; `compact` = the gaps
	 *  beside a band DECLARED thin (data-compact), an intended second step; `ratio` = widest / narrowest of the
	 *  other gaps of 24 px or more (closer bands are stacked, not spaced) — null with fewer than two. */
	rhythm: { bands: number; gaps: number[]; compact: number[]; ratio: number | null }
	/** ADR-086 P1: the brand mark at the site header's left — a bare `icon` (the 16 px stock-icon tell), a
	 *  `symbol` or `monogram` in a shape, a text `wordmark`, or an `image`; `height` of the mark in px. */
	logo: { kind: 'icon' | 'symbol' | 'monogram' | 'wordmark' | 'image'; height: number; text: string } | null
	/** Is the template's dark class on <html>? (Whether the app's colors followed is the capture's call.) */
	dark: boolean
	/** A section that threw inside the expression — the rest still reports. */
	errors?: string[]
}

/** One view of an app as a capture saw it. */
export interface CapturedView {
	name: string
	/** False when the flow could not find the control that leads here — reported, never a failure. */
	reached: boolean
	/** Uncaught runtime errors raised while this view was open. */
	errors: string[]
	metrics?: ViewMetrics
}

/** HARD from day one — only the objective classes (ADR-085 §D). Everything else is reported, SOFT. */
export function hardFindings(v: CapturedView): string[] {
	if (!v.reached || !v.metrics) return []
	const m = v.metrics
	const out: string[] = []
	if (v.errors.length) out.push(`runtime error: ${v.errors[0]}`)
	if (m.blank) out.push('blank view')
	if (m.images.broken) out.push(`${m.images.broken} broken image${m.images.broken > 1 ? 's' : ''}: ${m.images.brokenSrc[0] ?? ''}`)
	if (m.contrast.invisibleInteractive) out.push(`${m.contrast.invisibleInteractive} invisible button/link label${m.contrast.invisibleInteractive > 1 ? 's' : ''} (<1.5:1)`)
	return out
}

export function viewStatus(v: CapturedView): 'pass' | 'fail' | 'unreachable' {
	return !v.reached ? 'unreachable' : hardFindings(v).length ? 'fail' : 'pass'
}

/** Largest movement (px) of any chrome edge across views; null with fewer than two views carrying chrome. */
export function chromeDrift(views: ViewMetrics[]): number | null {
	let worst: number | null = null
	for (const part of ['header', 'footer'] as const) {
		for (const edge of ['left', 'right'] as const) {
			const xs = views.map((v) => v.chrome[part]?.[edge]).filter((x): x is number => typeof x === 'number')
			if (xs.length > 1) worst = Math.max(worst ?? 0, Math.max(...xs) - Math.min(...xs))
		}
	}
	return worst
}

/** The in-page measurement. Plain JS in String.raw (regex backslashes stay literal); no `${` or backticks. */
export const DESIGN_METRICS_EXPR = String.raw`(async () => {
	const errors = []
	const safe = (name, f, fallback) => { try { return f() } catch (e) { errors.push(name + ': ' + String((e && e.message) || e).slice(0, 120)); return fallback } }
	const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0' }
	const q = (sel, root) => [...(root || document).querySelectorAll(sel)].filter(vis)
	const isLeaf = (e) => e.matches('img,svg,video,canvas,picture') || (!e.children.length && e.textContent.trim())
	const edges = (els) => {
		const rs = els.map((e) => e.getBoundingClientRect())
		return rs.length ? { left: Math.round(Math.min(...rs.map((r) => r.left))), right: Math.round(Math.max(...rs.map((r) => r.right))) } : null
	}

	// 1. The 2026-09-27 fields — ab-measure's domMetrics: same selectors, same moment (nothing has scrolled).
	const legacy = safe('legacy', () => {
		const px = (el) => (el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 0)
		const content = edges(q('body *').filter((e) => isLeaf(e) && !e.closest('header,footer,nav')))
		return {
			textChars: document.body.innerText.trim().length,
			footers: q('footer,[data-block="footer"]').length,
			headers: q('header,[data-block="navbar"]').length,
			contentLeft: content ? content.left : null,
			contentRight: content ? content.right : null,
			h1px: px(q('h1')[0]),
			h2px: px(q('h2')[0]),
			pageHeight: document.documentElement.scrollHeight,
		}
	}, {})

	// 2. Chrome = the SITE header/footer, found by GEOMETRY, not ancestry: generated apps wrap the whole page in
	//    <main> and even put the header inside the hero <section> (measured, 09-27 Luna and Qwen landings). The
	//    site header is the first WIDE header (or, lacking one, nav) at the top of the document; the site footer
	//    is the last wide footer. A card's own <header>/<footer> is narrow, so it never qualifies.
	const chrome = safe('chrome', () => {
		const wide = (e) => e.getBoundingClientRect().width >= innerWidth * 0.6
		const nearTop = (e) => e.getBoundingClientRect().top + window.scrollY < 200
		const header = q('[data-block="navbar"]')[0] || q('header').filter(wide).find(nearTop) || q('nav').filter(wide).find(nearTop)
		const footer = q('[data-block="footer"]').pop() || q('footer').filter(wide).pop()
		// The CONTAINER's inner edges, not the content's: a cart badge appearing moves the last icon (measured:
		// +36 px on every template shop once the cart had an item) but is not the page jumping. Descend through
		// single wide wrappers (the mx-auto max-w-… div) and take that box minus its padding.
		const box = (root) => {
			if (!root) return null
			let c = root
			for (;;) {
				const kids = [...c.children].filter(vis)
				if (kids.length !== 1 || kids[0].getBoundingClientRect().width < c.getBoundingClientRect().width * 0.5) break
				c = kids[0]
			}
			const r = c.getBoundingClientRect(), s = getComputedStyle(c)
			return { left: Math.round(r.left + parseFloat(s.paddingLeft)), right: Math.round(r.right - parseFloat(s.paddingRight)) }
		}
		return { header: box(header), footer: box(footer) }
	}, { header: null, footer: null })

	// 3. Blank: no text worth the name and no sizeable media — a crashed React tree leaves #root empty.
	const blank = safe('blank', () => {
		const media = q('img,video,canvas,picture').reduce((a, e) => { const r = e.getBoundingClientRect(); return a + r.width * r.height }, 0)
		return (legacy.textChars || 0) < 40 && media < 10000
	}, false)

	// 4. Horizontal overflow. A fixed layer (an off-canvas drawer) or a clipping/scrolling ancestor keeps an
	//    element from scrolling the PAGE, so it is not overflow. Report the outermost offenders only.
	const overflow = safe('overflow', () => {
		const vw = document.documentElement.clientWidth
		const contained = (el) => {
			for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
				const s = getComputedStyle(p)
				if (s.position === 'fixed' || (p !== el && s.overflowX !== 'visible')) return true
			}
			return false
		}
		const out = q('body *').filter((e) => e.getBoundingClientRect().right > vw + 1 && !contained(e))
		const outer = out.filter((e) => !out.some((o) => o !== e && o.contains(e)))
		const name = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
		return { x: Math.max(0, document.documentElement.scrollWidth - vw), count: outer.length, samples: outer.slice(0, 5).map((e) => name(e) + ' +' + Math.round(e.getBoundingClientRect().right - vw) + 'px') }
	}, { x: 0, count: 0, samples: [] })

	// 5. Contrast against the REAL background: sweep the page a viewport at a time; for each text run read the
	//    element stack under it (elementsFromPoint — overlays and positioned photos included, with
	//    pointer-events forced on so pass-through layers still register) and composite the layers on a 1x1
	//    canvas, which parses any color the page can use (oklch, color-mix results) and alpha-blends like the
	//    page does. Text over a photo/video or a url() background is UNKNOWN, never guessed.
	const style = document.createElement('style')
	const contrast = await (async () => {
		try {
			style.textContent = '*{pointer-events:auto!important;scroll-behavior:auto!important}'
			document.head.appendChild(style)
			const cv = document.createElement('canvas')
			cv.width = cv.height = 1
			const ctx = cv.getContext('2d', { willReadFrequently: true })
			const alphaOf = (c) => { ctx.globalAlpha = 1; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3] / 255 }
			const paint = (layers) => {
				ctx.globalAlpha = 1
				ctx.clearRect(0, 0, 1, 1)
				for (const l of layers) { ctx.globalAlpha = l.alpha; ctx.fillStyle = '#000'; ctx.fillStyle = l.color; ctx.fillRect(0, 0, 1, 1) }
				const d = ctx.getImageData(0, 0, 1, 1).data
				return [d[0], d[1], d[2]]
			}
			const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
			const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
			const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
			const probe = document.createElement('div') // the page's own canvas color: white, or dark under color-scheme: dark
			probe.style.cssText = 'position:absolute;width:0;height:0;background:Canvas'
			document.documentElement.appendChild(probe)
			const canvasColor = getComputedStyle(probe).backgroundColor
			probe.remove()
			const opacityOf = (el) => { let o = 1; for (let p = el; p; p = p.parentElement) { const v = parseFloat(getComputedStyle(p).opacity); o *= isNaN(v) ? 1 : v } return o }
			const STOP = /(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-fA-F]{3,8}\b|\btransparent\b/g
			const MEDIA = ['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'SVG', 'IFRAME', 'OBJECT', 'EMBED']
			// The first own text run with a letter or digit. Punctuation-only runs (a "·" separator, a lone ".") are
			// decoration, which WCAG exempts as incidental text (measured: 09-27 Luna landings' worst "failures").
			const textOf = (el) => [...el.childNodes].find((n) => n.nodeType === 3 && /[\p{L}\p{N}]/u.test(n.textContent))
			const measure = (el) => {
				const range = document.createRange()
				range.selectNodeContents(textOf(el))
				const rect = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0)
				if (!rect) return { unknown: 'no-box' }
				const x = rect.left + Math.min(rect.width / 2, 12), y = rect.top + rect.height / 2
				if (y < 1 || y > innerHeight - 1 || x < 0 || x >= innerWidth) return null // not in view at this step
				if (el.closest('button:disabled,[aria-disabled="true"],fieldset:disabled')) return { unknown: 'disabled' } // WCAG exempts inactive UI
				const cs = getComputedStyle(el)
				const fg = cs.getPropertyValue('-webkit-text-fill-color') || cs.color
				const op = opacityOf(el)
				if (op < 0.2) return { unknown: 'fading' }
				if (alphaOf(fg) === 0) return { unknown: 'gradient-text' }
				const stack = document.elementsFromPoint(x, y)
				const at = stack.indexOf(el)
				if (at < 0) return { unknown: 'covered' }
				const layers = [] // top → bottom; a gradient is one slot, tried at each of its stops
				let grad = null
				for (let i = at; i < stack.length; i++) {
					const e = stack[i], s = getComputedStyle(e)
					if (i > at && MEDIA.includes(e.tagName.toUpperCase())) return { unknown: 'over-media' }
					if (s.backgroundImage && s.backgroundImage !== 'none') {
						const colors = s.backgroundImage.match(STOP)
						if (/url\(/.test(s.backgroundImage) || grad || !colors) return { unknown: 'over-image' }
						grad = { slot: layers.length, colors, alpha: opacityOf(e) }
						layers.push(null)
						// No continue: CSS paints the element's OWN background-color beneath its gradients. Skipping it sent
						// a transparent stop through to the PAGE (ADR-086 P0: light hero text on "radial-gradient(…, transparent),
						// #064e3b" scored 1:1 against the mint page, the green panel never seen).
					}
					const a = alphaOf(s.backgroundColor)
					if (a > 0) {
						const o = opacityOf(e)
						layers.push({ color: s.backgroundColor, alpha: o })
						if (a * o >= 0.999) break
					}
				}
				const variants = grad ? grad.colors.map((c) => layers.map((l, i) => (i === grad.slot ? { color: c, alpha: grad.alpha } : l))) : [layers]
				let lo = Infinity, hi = 0, pair = null
				for (const ls of variants) {
					const under = [{ color: canvasColor, alpha: 1 }].concat(ls.slice().reverse())
					const b = paint(under), f = paint(under.concat([{ color: fg, alpha: op }]))
					const r = ratio(f, b)
					if (r < lo) { lo = r; pair = [f, b] }
					hi = Math.max(hi, r)
				}
				const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400
				const kind = el.closest('button,[role="button"],input[type="submit"]') ? 'button' : el.closest('a[href]') ? 'link' : 'text'
				return { text: textOf(el).textContent.trim().slice(0, 40), kind, lo, hi, op, need: size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5, fg: hex(pair[0]), bg: hex(pair[1]) }
			}
			const pending = new Set([...document.querySelectorAll('body *')].filter((el) => {
				if (el.closest('svg,script,style,noscript,template,title') || !textOf(el) || !vis(el)) return false
				const r = el.getBoundingClientRect()
				return r.width > 2 && r.height > 2 // not sr-only
			}))
			const results = []
			for (let y = 0, step = Math.max(200, innerHeight - 100); ; y += step) {
				window.scrollTo(0, y)
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
				for (const a of document.getAnimations()) { try { if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish() } catch (e) {} }
				for (const el of [...pending]) {
					if (!el.isConnected) { pending.delete(el); continue }
					const r = measure(el)
					if (r === null) continue
					pending.delete(el)
					results.push(r)
				}
				if (!pending.size || y + innerHeight >= document.documentElement.scrollHeight || y > 60000) break
			}
			const ok = results.filter((r) => !r.unknown)
			const unknown = {}
			for (const r of results) if (r.unknown) unknown[r.unknown] = (unknown[r.unknown] || 0) + 1
			const failing = ok.filter((r) => r.lo < r.need).sort((a, b) => a.lo - b.lo)
			// "Invisible" = under 1.5:1 even against the best gradient stop, on FULLY shown text (a mid-fade reveal
			// is not a verdict) — the HARD class when it is a button or link label.
			const invisible = ok.filter((r) => r.hi < 1.5 && r.op >= 0.9)
			const seen = new Set(), worst = []
			for (const r of failing) {
				const k = r.text + r.fg + r.bg
				if (seen.has(k) || worst.length === 8) continue
				seen.add(k)
				worst.push({ text: r.text, kind: r.kind, ratio: Math.round(r.lo * 100) / 100, fg: r.fg, bg: r.bg })
			}
			return { checked: ok.length, unknown, unmeasured: pending.size, fail: failing.length, invisible: invisible.length, invisibleInteractive: invisible.filter((r) => r.kind !== 'text').length, worst }
		} catch (e) {
			errors.push('contrast: ' + String((e && e.message) || e).slice(0, 120))
			return { checked: 0, unknown: {}, unmeasured: 0, fail: 0, invisible: 0, invisibleInteractive: 0, worst: [] }
		} finally {
			style.remove()
			window.scrollTo(0, 0)
		}
	})()

	// 6. Broken images — after the sweep, so lazy images below the fold have been asked to load (≤3 s wait).
	//    An <img> with an EMPTY src that still takes space is broken too (an invented photo() name returns '').
	const images = await (async () => {
		try {
			const imgs = [...document.images]
			const settle = (i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }) })
			await Promise.race([Promise.all(imgs.filter((i) => !i.complete).map(settle)), new Promise((r) => setTimeout(r, 3000))])
			const broken = imgs.filter((i) => {
				if (!i.complete || i.naturalWidth > 0 || getComputedStyle(i).display === 'none') return false
				const src = i.currentSrc || i.getAttribute('src') || ''
				if (/\.svg(?:[?#]|$)|^data:image\/svg/i.test(src)) return false // intrinsic-size-less SVGs report 0
				const r = i.getBoundingClientRect()
				return src !== '' || r.width * r.height > 0
			})
			return { total: imgs.length, broken: broken.length, brokenSrc: broken.slice(0, 5).map((i) => (i.currentSrc || i.getAttribute('src') || '(empty src)').slice(0, 160)) }
		} catch (e) {
			errors.push('images: ' + String((e && e.message) || e).slice(0, 120))
			return { total: 0, broken: 0, brokenSrc: [] }
		}
	})()

	// 7. Rhythm (ADR-086 P1): the gaps between the page's bands, content to content, in DOCUMENT coordinates —
	//    after the sweep, so scroll-reveal content is shown. The flow is the wide element with the most wide
	//    children. A band with its own background, image or top border is an object (its edge is what the eye
	//    sees); otherwise its extent is its text, media and surfaces (cards, panels, bordered boxes).
	const wideEl = (e) => vis(e) && e.getBoundingClientRect().width >= innerWidth * 0.6
	const nearTop = (e) => e.getBoundingClientRect().top + window.scrollY < 200
	const siteHeader = q('[data-block="navbar"]')[0] || q('header').filter(wideEl).find(nearTop) || q('nav').filter(wideEl).find(nearTop)
	const clearBg = (c) => c === 'transparent' || c === 'rgba(0, 0, 0, 0)'
	const rhythm = safe('rhythm', () => {
		const pinned = (e, stop) => { for (let p = e; p && p !== stop; p = p.parentElement) { const ps = getComputedStyle(p).position; if (ps === 'fixed' || ps === 'sticky') return true } return false }
		let flow = null, most = 1
		for (const p of [document.body, ...document.body.querySelectorAll('*')]) {
			if (!wideEl(p)) continue
			const n = [...p.children].filter((c) => wideEl(c) && !pinned(c, p)).length
			if (n > 1 && n >= most) { most = n; flow = p } // ties go to the deeper element: <main>, not its wrapper
		}
		if (!flow) return { bands: 0, gaps: [], compact: [], ratio: null } // the full ViewMetrics shape on every path
		let pageBg = 'rgb(255, 255, 255)'
		for (let p = flow; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!clearBg(c)) { pageBg = c; break } }
		const siteFooter = q('[data-block="footer"]').pop() || q('footer').filter(wideEl).pop()
		const edged = (s, sides) => sides.some((d) => parseFloat(s['border' + d + 'Width']) > 0 && s['border' + d + 'Style'] !== 'none')
		const own = (e) => { const s = getComputedStyle(e); return (!clearBg(s.backgroundColor) && s.backgroundColor !== pageBg) || s.backgroundImage !== 'none' || edged(s, ['Top']) }
		const surface = (e) => { const s = getComputedStyle(e); return (!clearBg(s.backgroundColor) && s.backgroundColor !== pageBg) || s.backgroundImage !== 'none' || s.boxShadow !== 'none' || edged(s, ['Top', 'Right', 'Bottom', 'Left']) }
		const box = (band) => {
			if (own(band)) { const r = band.getBoundingClientRect(); return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY } }
			let t = Infinity, b = -Infinity
			for (const e of band.querySelectorAll('*')) {
				if (!vis(e) || (siteHeader && siteHeader.contains(e)) || pinned(e, band) || !(isLeaf(e) || surface(e))) continue
				const r = e.getBoundingClientRect()
				if (r.height < 1) continue
				t = Math.min(t, r.top + window.scrollY)
				b = Math.max(b, r.bottom + window.scrollY)
			}
			return t < b ? { top: t, bottom: b } : null
		}
		const bands = [...flow.children].filter((c) => wideEl(c) && !pinned(c, flow) && !(siteHeader && (c === siteHeader || siteHeader.contains(c))) && c !== siteFooter)
		if (siteFooter && !bands.some((b) => b.contains(siteFooter))) bands.push(siteFooter)
		const boxes = bands.map((b) => { const r = box(b); return r && { top: r.top, bottom: r.bottom, compact: b.matches('[data-compact]') } }).filter(Boolean).sort((a, b) => a.top - b.top)
		const gaps = [], compact = [], full = []
		for (let i = 1; i < boxes.length; i++) {
			const g = Math.max(0, Math.round(boxes[i].top - boxes[i - 1].bottom))
			gaps.push(g)
			// A band DECLARED thin (the template's <Section compact> stamps data-compact) sits close by design: its
			// gaps are a second, intended step, reported apart. Undeclared apps (a blank start) have every gap counted.
			;(boxes[i].compact || boxes[i - 1].compact ? compact : full).push(g)
		}
		// Under 24 px is STACKING, not spacing (measured, ADR-086 P0: a landing's hero sat 8 px above its logo strip,
		// and 96 / 8 read as a 12× rhythm; deliberate section gaps in every captured app were 32 px or more).
		const spaced = full.filter((g) => g >= 24)
		return { bands: boxes.length, gaps, compact, ratio: spaced.length > 1 ? Math.round((Math.max(...spaced) / Math.min(...spaced)) * 100) / 100 : null }
	}, { bands: 0, gaps: [], compact: [], ratio: null })

	// 8. The brand mark (ADR-086 P1): the leftmost text/mark cluster of the site header, grown to its widest
	//    still-narrow ancestor (the link or lockup), then classified by what carries the mark.
	const logo = safe('logo', () => {
		if (!siteHeader) return null
		const hr = siteHeader.getBoundingClientRect()
		const zone = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.width < hr.width * 0.45 && r.left < hr.left + hr.width * 0.4 }
		const cands = q('*', siteHeader).filter((e) => zone(e) && (e.matches('svg,img') || !!e.querySelector('svg,img') || [...e.childNodes].some((n) => n.nodeType === 3 && /[\p{L}\p{N}]/u.test(n.textContent))))
		let brand = cands.filter((e) => !cands.some((o) => o !== e && o.contains(e))).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]
		if (!brand) return null
		while (brand.parentElement && brand.parentElement !== siteHeader && siteHeader.contains(brand.parentElement) && zone(brand.parentElement)) brand = brand.parentElement
		const text = (brand.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40)
		const H = (e) => Math.round(e.getBoundingClientRect().height)
		const img = brand.matches('img') ? brand : q('img', brand)[0]
		if (img) return { kind: 'image', height: H(img), text }
		const shape = q('*', brand).find((e) => {
			const s = getComputedStyle(e), r = e.getBoundingClientRect()
			return (!clearBg(s.backgroundColor) || s.backgroundImage !== 'none' || parseFloat(s.borderTopWidth) > 0) && r.height >= 16 && r.height <= 80 && r.width >= r.height * 0.6 && r.width <= r.height * 1.8
		})
		if (shape) {
			const letters = (shape.innerText || '').replace(/\s+/g, '')
			return { kind: !shape.querySelector('svg') && letters.length >= 1 && letters.length <= 3 ? 'monogram' : 'symbol', height: H(shape), text }
		}
		const svg = brand.matches('svg') ? brand : q('svg', brand)[0]
		if (svg) return { kind: /lucide/.test(String(svg.getAttribute('class') || '')) || H(svg) < 20 ? 'icon' : 'symbol', height: H(svg), text }
		return { kind: 'wordmark', height: Math.round(parseFloat(getComputedStyle(brand).fontSize)), text }
	}, null)

	const out = Object.assign({}, legacy, { blank, chrome, images, overflow, contrast, viewport: { w: innerWidth, h: innerHeight }, rhythm, logo, dark: document.documentElement.classList.contains('dark') })
	if (errors.length) out.errors = errors
	return out
})()`
