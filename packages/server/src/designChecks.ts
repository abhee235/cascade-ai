// designChecks.ts — SOURCE-side design checks (ADR-085 P0). Pure functions over file TEXT: no fs, no imports,
// no Node APIs. One definition serves the server (TemplateAudit and the post-turn check, P1–P2), the bench
// (scripts/eval/designRescore.mts) and plain-node check.mjs files (Node ≥22.18 strips the types on import),
// so a number in a bench report and a finding in a build mean the same thing.
//
// Philosophy, inherited from eval/builder/_lib/designLint.mjs: objective facts only. A check that fires on
// correct work teaches models to game the bar (ADR-057 retired its one-CTA check for exactly that), so every
// class here is REPORTED; which become HARD is decided per phase on measured false-positive rates.

export interface SourceFile {
	/** Relative to the project root, '/'-separated (e.g. 'src/App.tsx'). */
	path: string
	text: string
}

/** Layers the app COMPOSES but does not own: the frozen kit and blocks, and the theme presets (where raw
 *  color values are the point). Path-based, not name-based — an app's own src/features/x/ui/ is its own
 *  code and is checked (why designLint moved off name matching). */
const NOT_OWN = ['src/components/ui/', 'src/components/blocks/', 'src/themes/']

/** The model's own styling surface: code and CSS under src/, minus the layers above. */
export function isOwnSource(path: string): boolean {
	const p = path.replaceAll('\\', '/')
	return p.startsWith('src/') && /\.(?:tsx?|jsx?|css)$/.test(p) && !p.endsWith('.d.ts') && !NOT_OWN.some((d) => p.startsWith(d))
}

/** ADR-086 P1 — the template is open: a kit or block file the app EDITED or ADDED is its own code. `shipped(path)`
 *  returns the template's versions of that file (base + every skin), undefined when the template ships none. */
export type ShippedVersions = (path: string) => string[] | undefined

/** How much of a file is the app's: 'all' (own source, or a kit/block file the template never shipped), 'none'
 *  (untouched template code, or no `shipped` lookup), or the shipped versions to subtract — an edited file counts
 *  only what the edit ADDED, so a light edit never inherits the template's own colors. */
function ownership(f: SourceFile, shipped?: ShippedVersions): 'all' | 'none' | string[] {
	if (isOwnSource(f.path)) return 'all'
	const p = f.path.replaceAll('\\', '/')
	if (!shipped || !/^src\/components\/(?:ui|blocks)\/.+\.(?:tsx?|jsx?|css)$/.test(p)) return 'none'
	const versions = shipped(p)
	if (!versions?.length) return 'all'
	const lf = (s: string) => s.replace(/\r\n/g, '\n')
	return versions.some((v) => lf(v) === lf(f.text)) ? 'none' : versions
}

/** `found` minus what the closest shipped version already has (a multiset difference by `key`). */
function added<T>(found: T[], versions: string[], scan: (text: string) => T[], key: (t: T) => string): T[] {
	let fewest = found
	for (const v of versions) {
		const left = new Map<string, number>()
		for (const t of scan(v)) left.set(key(t), (left.get(key(t)) ?? 0) + 1)
		const rest = found.filter((t) => {
			const n = left.get(key(t)) ?? 0
			if (n > 0) left.set(key(t), n - 1)
			return n === 0
		})
		if (rest.length < fewest.length) fewest = rest
	}
	return fewest
}

/** Blank out comments, keeping every newline so line numbers survive. A color in a comment is not a rendered
 *  color ("// was #7c3aed, now bg-primary" is a model doing the right thing). `//` after a `:` is a URL. */
export function stripComments(text: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ')
	return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\])(\/\/[^\n]*)/gm, (_m, pre: string, c: string) => pre + blank(c))
}

/** 1-based line of a character offset. */
function lineAt(text: string, index: number): number {
	let n = 1
	for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++
	return n
}

// CSS Color 4 named colors → sRGB hex. Used twice: to DETECT `color: tomato` in app code, and to CONVERT a
// theme value for contrast. (transparent / currentcolor are keywords, not colors, and are never raw.)
const NAMED_HEX: Record<string, string> = Object.fromEntries(
	(
		'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 ' +
		'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 ' +
		'chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff ' +
		'darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 ' +
		'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 ' +
		'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f ' +
		'darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 ' +
		'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ' +
		'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 ' +
		'honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa ' +
		'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff ' +
		'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 ' +
		'lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
		'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 ' +
		'mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 ' +
		'mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 ' +
		'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 ' +
		'oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa ' +
		'palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f ' +
		'pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f ' +
		'royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee ' +
		'sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
		'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 ' +
		'violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32'
	)
		.split(' ')
		.map((pair) => pair.split(':') as [string, string]),
)

// ── Raw colors ──────────────────────────────────────────────────────────────────────────────────────────
// A raw color is a LITERAL color in the app's own code — every notation, because a model that is told "no
// hex" writes oklch() instead (measured 2026-09-27: qwen36's landing had 0 hex and 48 arbitrary oklch
// classes). Token-derived colors are not raw: `hsl(var(--x))` and `oklch(from var(--x) l c h / .5)` carry
// nested parens, which the function pattern below cannot span, so they never match (the template's own
// index.css shadows use exactly that form).

export type ColorNotation = 'hex' | 'rgb' | 'hsl' | 'hwb' | 'oklch' | 'oklab' | 'lab' | 'lch' | 'color' | 'named' | 'palette'

export interface RawColorHit {
	path: string
	line: number
	notation: ColorNotation
	match: string
}

export interface RawColorReport {
	total: number
	byNotation: Partial<Record<ColorNotation, number>>
	hits: RawColorHit[]
}

// `_` may touch a hex on either side: it is Tailwind's space in arbitrary values (`shadow-[0_0_10px_#d6fa6b]`).
const HEX = /(?<![&0-9A-Za-z#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z-])/g
// `[^()]*`: no nesting, so var()/from-var()/calc() forms are structurally excluded. Underscores are
// Tailwind's space in arbitrary values (`bg-[oklch(0.12_0.01_292)]`).
const COLOR_FN = /\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(([^()]*)\)/g
const COLOR_SPACE_FN = /\bcolor\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\b[^()]*\)/g
// Tailwind palette + white/black utilities. `bg-black/NN` is the modal scrim and exempt (designLint's rule:
// a scrim must darken in BOTH themes, so a token would be wrong there).
const PALETTE =
	/(?<![\w-])(?:bg|text|border(?:-[xytrblse])?|from|via|to|ring(?:-offset)?|fill|stroke|outline|decoration|divide|placeholder|caret|accent|shadow)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\/\d{1,3})?(?![\w-])/g
// Named colors only where a color is being SET: CSS color properties and custom properties, JS style
// objects, SVG/icon attributes. Lowercase only — product data writes `color: 'Navy'`, styles write 'navy'.
const NAMED_WORD = new RegExp(`\\b(?:${Object.keys(NAMED_HEX).join('|')})\\b`, 'g')
const CSS_COLOR_DECL =
	/(?:^|[{;\s])(?:--[\w-]+|color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|outline(?:-color)?|fill|stroke|(?:box|text)-shadow|(?:text-decoration|caret|accent|column-rule|stop|flood|lighting)-color)\s*:\s*([^;{}]*)/g
const JS_COLOR_PROP =
	/\b(?:color|background(?:Color)?|border(?:Top|Right|Bottom|Left)?(?:Color)?|outline(?:Color)?|fill|stroke|(?:box|text)Shadow|(?:textDecoration|caret|accent|columnRule|stop|flood|lighting)Color)\s*:\s*(['"`])([^'"`\n]*)\1/g
const JSX_COLOR_ATTR = /\b(?:fill|stroke|color|stopColor|floodColor|lightingColor)=(['"])([^'"]*)\1/g

/** Is this `#…` a color, or prose that happens to be hex ("Order #1042", `href="#cafe"`)? */
function isHexColor(text: string, index: number, match: string): boolean {
	if (/(?:href|to)=\{?["'`]$/.test(text.slice(Math.max(0, index - 8), index))) return false
	const digits = match.slice(1)
	// Decimal-only short hex is an order/room/rank number far more often than a color — except the
	// repeated-digit grays (#000, #333, #9999) that really are everyday colors.
	if (digits.length <= 4 && /^\d+$/.test(digits)) return /^(\d)\1+$/.test(digits)
	return true
}

/** Every raw color in the app's own files (see isOwnSource), comments excluded. `themeFiles` names the files
 *  that DEFINE the tokens when they live outside src/themes/ (a blank-start project keeps its theme in, say,
 *  src/theme.css — ADR-086): a color there is the theme itself, not a raw color outside it. `shipped` makes
 *  edited kit/block files count (ADR-086 P1, see ownership). */
export function rawColors(files: SourceFile[], opts: { themeFiles?: string[]; shipped?: ShippedVersions } = {}): RawColorReport {
	const hits: RawColorHit[] = []
	for (const f of files) {
		if (opts.themeFiles?.includes(f.path)) continue
		const own = ownership(f, opts.shipped)
		if (own === 'none') continue
		const found = rawHits(f.path, f.text)
		hits.push(...(own === 'all' ? found : added(found, own, (v) => rawHits(f.path, v), (h) => `${h.notation}:${h.match}`)))
	}
	const byNotation: Partial<Record<ColorNotation, number>> = {}
	for (const h of hits) byNotation[h.notation] = (byNotation[h.notation] ?? 0) + 1
	return { total: hits.length, byNotation, hits }
}

/** One file's raw colors, whoever owns it. */
function rawHits(path: string, source: string): RawColorHit[] {
	const hits: RawColorHit[] = []
	const text = stripComments(source)
	const add = (index: number, notation: ColorNotation, match: string) => hits.push({ path, line: lineAt(text, index), notation, match })
	for (const m of text.matchAll(HEX)) if (isHexColor(text, m.index, m[0])) add(m.index, 'hex', m[0])
	for (const m of text.matchAll(COLOR_FN)) {
		const args = m[2]!
		if (/^\s*from\b/.test(args) || !/\d|\$\{/.test(args)) continue // relative syntax / `rgb(r, g, b)` in code
		add(m.index, m[1]!.replace(/a$/, '') as ColorNotation, m[0])
	}
	for (const m of text.matchAll(COLOR_SPACE_FN)) add(m.index, 'color', m[0])
	for (const m of text.matchAll(PALETTE)) if (!/^bg-black\//.test(m[0])) add(m.index, 'palette', m[0])
	const named = (base: number, value: string) => {
		for (const w of value.replace(/url\([^)]*\)/g, (u) => ' '.repeat(u.length)).matchAll(NAMED_WORD)) add(base + w.index, 'named', w[0])
	}
	if (path.endsWith('.css')) {
		for (const m of text.matchAll(CSS_COLOR_DECL)) named(m.index + m[0].length - m[1]!.length, m[1]!)
	} else {
		for (const m of text.matchAll(JS_COLOR_PROP)) named(m.index + m[0].length - m[2]!.length - 1, m[2]!)
		for (const m of text.matchAll(JSX_COLOR_ATTR)) named(m.index + m[0].length - m[2]!.length - 1, m[2]!)
	}
	return hits
}

// ── The never-list (ADR-083 principle 6, ADR-085): default looks and fake content, as source facts ─────────

export interface Finding {
	check: 'glyph-icon' | 'arrow-cta' | 'dot-meta' | 'brand-wall' | 'keyword-photo' | 'keyword-hero-photo'
	path: string
	line: number
	text: string
}

// Symbols that read as ICONS when they stand alone: technical, geometric shapes, misc symbols, dingbats,
// misc symbols-and-arrows, emoji — plus × (the hand-rolled close button). NOT the Arrows block: an arrow
// alone in a span is usually typography ("4,000 <span>→</span> 11"); the arrow TELL is arrow-cta below.
const GLYPH = '[\\u00D7\\u2300-\\u23FF\\u25A0-\\u25FF\\u2600-\\u27BF\\u2B00-\\u2BFF\\u{1F300}-\\u{1FAFF}]\\uFE0F?'
// A JSX child, or an icon-ish property, that is NOTHING but 1–5 such glyphs (`<span>✦</span>`, `icon: '★'`).
const GLYPH_ICON = new RegExp(`>\\s*(?:${GLYPH}){1,5}\\s*<|\\b(?:icon|emoji|symbol|glyph)\\s*:\\s*(['"\`])\\s*(?:${GLYPH}){1,5}\\s*\\1`, 'gu')
// Label text that ENDS in an arrow ("Shop now →", 'Get started ->'), or an arrow-only span closing a button
// or link (`Start <span>→</span></Button>`). Mid-text arrows are breadcrumbs and "A → B" prose, not CTAs.
const ARROW = '(?:→|->|›|»|⟶|↗)'
const ARROW_CTA = new RegExp(`[A-Za-z][^<>{}'"\`\\n]{0,40}\\s${ARROW}\\s*(?=[<'"\`])|>\\s*${ARROW}\\s*</(?:span|i)>\\s*</(?:button|a|Button|Link)>`, 'g')
// "A · B · C" meta strings (two or more separators), and arrays joined into them in code.
const DOT_META = /[^<>{}'"`\n·]{1,40}\s·\s[^<>{}'"`\n·]{1,40}\s·\s[^<>{}'"`\n]{1,40}|\.join\(\s*['"`]\s*·\s*['"`]\s*\)/g
// Real companies a generated page is likely to claim as customers. Matched case-sensitively as proper nouns,
// and only as ≥2 distinct brands near a CUSTOMER word: "Pay with Stripe" and a pricing tier's "Slack, Linear
// & GitHub" (integrations, measured in the 09-27 Luna runs) are not a customer claim; `LogoStrip label="Trusted
// by…" items={['Vercel','Linear',…]}` and `const CUSTOMERS = ['Stripe',…]` are.
const BRANDS = (
	'Stripe Vercel Notion Linear Figma Slack Shopify Airbnb Uber Lyft Google Microsoft Apple Amazon Netflix Spotify ' +
	'GitHub GitLab Atlassian Dropbox Adobe Salesforce HubSpot Zoom Twilio Datadog Cloudflare OpenAI Anthropic Meta ' +
	'Facebook Instagram LinkedIn Pinterest Tesla Nike Adidas Samsung Intel IBM Oracle Cisco Nvidia PayPal Discord ' +
	'Reddit YouTube Canva Asana Trello Intercom Zendesk Mailchimp Squarespace Webflow Supabase Firebase MongoDB ' +
	'Postman Docker Airtable Loom Miro Coinbase Revolut Klarna DoorDash Instacart Etsy Starbucks Deloitte Accenture'
).split(' ')
// A brand as a STANDALONE item — a whole string (`['Stripe', 'Vercel']`) or a whole JSX text node — which is
// how a logo wall is written. Prose mentions ("Slack and GitHub alerts", an FAQ about integrations) are not.
const BRAND_ITEM = new RegExp(`(['"\`])(${BRANDS.join('|')})\\1|>\\s*(${BRANDS.join('|')})\\s*<`, 'g')
// `(?![\w-])`: "customer-facing services" (a pricing tier, measured) is not a customer claim.
const CUSTOMER_WORD = /trusted|used by|loved by|\bcustomers?(?![\w-])|\bclients?(?![\w-])|teams at|companies|backed by|as seen|featured in|\blogos?(?![\w-])/i
// A photo chosen by KEYWORD or at random rather than for the subject: <Photo web="coffee beans"> (a non-URL
// web prop), webPhoto(), and the random/keyword hosts behind them. The module that DEFINES those helpers
// (the template's src/lib/photos.ts) is exempt — the TemplateAudit precedent: flagging it flags every app.
const KEYWORD_PHOTO = /<Photo\b[^>]*\bweb=["'](?!https?:)[^"']*["']|\bwebPhoto\(|loremflickr\.com|source\.unsplash\.com|picsum\.photos/g

/** The <Hero …/> element's own text, braces respected so `media={<Photo … />}` stays inside it. */
function heroSpans(text: string): [number, number][] {
	const spans: [number, number][] = []
	for (const m of text.matchAll(/<Hero\b/g)) {
		let depth = 0
		for (let i = m.index; i < text.length; i++) {
			const c = text[i]
			if (c === '{') depth++
			else if (c === '}') depth--
			else if (depth === 0 && (text.startsWith('/>', i) || text.startsWith('</Hero>', i))) {
				spans.push([m.index, i])
				break
			}
		}
	}
	return spans
}

/** The never-list over the app's own script files (CSS carries none of these); `shipped` as in rawColors. */
export function neverList(files: SourceFile[], opts: { shipped?: ShippedVersions } = {}): Finding[] {
	const out: Finding[] = []
	for (const f of files) {
		if (f.path.endsWith('.css')) continue
		const own = ownership(f, opts.shipped)
		if (own === 'none') continue
		const found = neverHits(f.path, f.text)
		out.push(...(own === 'all' ? found : added(found, own, (v) => neverHits(f.path, v), (h) => `${h.check}:${h.text}`)))
	}
	return out
}

/** One script file's never-list findings, whoever owns it. */
function neverHits(path: string, source: string): Finding[] {
	const out: Finding[] = []
	const text = stripComments(source)
	const add = (check: Finding['check'], index: number, s: string) => out.push({ check, path, line: lineAt(text, index), text: s.trim().slice(0, 80) })
	for (const m of text.matchAll(GLYPH_ICON)) add('glyph-icon', m.index, m[0])
	for (const m of text.matchAll(ARROW_CTA)) add('arrow-cta', m.index, m[0])
	for (const m of text.matchAll(DOT_META)) add('dot-meta', m.index, m[0])
	const heroes = heroSpans(text)
	for (const m of path === 'src/lib/photos.ts' ? [] : text.matchAll(KEYWORD_PHOTO)) {
		const inHero = heroes.some(([a, b]) => m.index >= a && m.index <= b)
		add(inHero ? 'keyword-hero-photo' : 'keyword-photo', m.index, m[0])
	}
	// Brand walls: each line carrying a customer word opens a window (3 lines up, 8 down — a label above its
	// logo array); ≥2 distinct brands inside it is one finding. Windows that overlap a reported one are skipped.
	const lines = text.split('\n')
	let reportedUntil = -1
	for (let i = 0; i < lines.length; i++) {
		if (i <= reportedUntil || !CUSTOMER_WORD.test(lines[i]!)) continue
		const from = Math.max(0, i - 3)
		const to = Math.min(lines.length, i + 9)
		const names = [...new Set(lines.slice(from, to).flatMap((l) => [...l.matchAll(BRAND_ITEM)].map((m) => m[2] ?? m[3]!)))]
		if (names.length < 2) continue
		out.push({ check: 'brand-wall', path, line: i + 1, text: names.join(', ') })
		reportedUntil = to - 1
	}
	return out
}

// ── Color math (CSS Color 4 matrices; sRGB out, gamut-clipped) ──────────────────────────────────────────

/** sRGB, gamma-encoded, each channel 0–1; alpha 0–1. */
export interface Rgba {
	r: number
	g: number
	b: number
	a: number
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * clamp01(c) : 1.055 * Math.min(1, c) ** (1 / 2.4) - 0.055) // out-of-gamut → clipped
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const mul = (m: number[][], v: number[]) => m.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!)
const XYZ65_TO_LIN_SRGB = [[3.2409699419045226, -1.537383177570094, -0.4986107602930034], [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559], [0.05563007969699366, -0.20397695888897652, 1.0569715142428786]]
const D50_TO_D65 = [[0.9554734527042182, -0.023098536874261423, 0.0632593086610217], [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008], [0.012314001688319899, -0.020507696433477912, 1.3303659366080753]]
const LIN_P3_TO_XYZ65 = [[0.4865709486482162, 0.26566769316909306, 0.1982172852343625], [0.2289745640697488, 0.6917385218365064, 0.079286914093745], [0, 0.04511338185890264, 1.043944368900976]]

function fromLinear(lin: number[], a: number): Rgba {
	const [r, g, b] = lin.map((c) => clamp01(gamma(c)))
	return { r: r!, g: g!, b: b!, a: clamp01(a) }
}
function oklabToRgba(L: number, A: number, B: number, a: number): Rgba {
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
	return fromLinear([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s], a)
}
function labToRgba(L: number, A: number, B: number, a: number): Rgba {
	const e = 216 / 24389, k = 24389 / 27
	const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200
	const xyz50 = [(fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * 0.96422, L > k * e ? fy ** 3 : L / k, (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * 0.82521]
	return fromLinear(mul(XYZ65_TO_LIN_SRGB, mul(D50_TO_D65, xyz50)), a)
}
function hslToRgba(h: number, s: number, l: number, a: number): Rgba {
	const f = (n: number) => {
		const k = (n + h / 30) % 12
		return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
	}
	return { r: clamp01(f(0)), g: clamp01(f(8)), b: clamp01(f(4)), a: clamp01(a) }
}

/** Parse one CSS number token: plain, percent (scaled by `pct` = the value 100% means), or angle → degrees. */
function num(tok: string | undefined, pct = 1): number {
	if (tok === undefined || tok === 'none') return 0
	const v = parseFloat(tok)
	if (tok.endsWith('%')) return (v / 100) * pct
	if (tok.endsWith('turn')) return v * 360
	if (tok.endsWith('grad')) return v * 0.9
	if (tok.endsWith('rad')) return (v * 180) / Math.PI
	return v
}

/** Any CSS color value → sRGB, or null (var(), relative syntax, unsupported spaces). */
export function parseColor(value: string): Rgba | null {
	const v = value.trim().toLowerCase()
	if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
	const hex = NAMED_HEX[v] ?? (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v)?.[1])
	if (hex) {
		const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
		const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255
		return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 }
	}
	const fn = /^(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(\s*([^()]*)\)$/.exec(v)
	if (!fn) return null
	const [body, alphaTok] = fn[2]!.replace(/_/g, ' ').split('/')
	let t = body!.trim().split(/[\s,]+/)
	let alpha = alphaTok === undefined ? undefined : num(alphaTok.trim(), 1)
	if (alpha === undefined && t.length === 4 && fn[1] !== 'color') alpha = num(t.pop(), 1) // legacy rgba(r,g,b,a)
	const a = alpha ?? 1
	switch (fn[1]) {
		case 'rgb':
		case 'rgba':
			return { r: clamp01(num(t[0], 255) / 255), g: clamp01(num(t[1], 255) / 255), b: clamp01(num(t[2], 255) / 255), a: clamp01(a) }
		case 'hsl':
		case 'hsla':
			return hslToRgba(((num(t[0]) % 360) + 360) % 360, clamp01(num(t[1], 100) / 100), clamp01(num(t[2], 100) / 100), a)
		case 'hwb': {
			const w = clamp01(num(t[1], 100) / 100), bl = clamp01(num(t[2], 100) / 100)
			if (w + bl >= 1) return { r: w / (w + bl), g: w / (w + bl), b: w / (w + bl), a: clamp01(a) }
			const base = hslToRgba(((num(t[0]) % 360) + 360) % 360, 1, 0.5, a)
			const mix = (c: number) => c * (1 - w - bl) + w
			return { r: mix(base.r), g: mix(base.g), b: mix(base.b), a: base.a }
		}
		case 'oklab':
			return oklabToRgba(num(t[0], 1), num(t[1], 0.4), num(t[2], 0.4), a)
		case 'oklch': {
			const C = num(t[1], 0.4), h = (num(t[2]) * Math.PI) / 180
			return oklabToRgba(num(t[0], 1), C * Math.cos(h), C * Math.sin(h), a)
		}
		case 'lab':
			return labToRgba(num(t[0], 100), num(t[1], 125), num(t[2], 125), a)
		case 'lch': {
			const C = num(t[1], 150), h = (num(t[2]) * Math.PI) / 180
			return labToRgba(num(t[0], 100), C * Math.cos(h), C * Math.sin(h), a)
		}
		default: {
			const [space, ...ch] = t
			t = ch
			const c = [num(t[0], 1), num(t[1], 1), num(t[2], 1)]
			if (space === 'srgb') return { r: clamp01(c[0]!), g: clamp01(c[1]!), b: clamp01(c[2]!), a: clamp01(a) }
			if (space === 'srgb-linear') return fromLinear(c, a)
			if (space === 'display-p3') return fromLinear(mul(XYZ65_TO_LIN_SRGB, mul(LIN_P3_TO_XYZ65, c.map(linear))), a)
			if (space === 'xyz' || space === 'xyz-d65') return fromLinear(mul(XYZ65_TO_LIN_SRGB, c), a)
			if (space === 'xyz-d50') return fromLinear(mul(XYZ65_TO_LIN_SRGB, mul(D50_TO_D65, c)), a)
			return null
		}
	}
}

/** WCAG 2 relative luminance of an sRGB color (alpha ignored — composite first). */
export function luminance(c: Rgba): number {
	return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}
/** WCAG 2 contrast ratio, 1–21. */
export function contrastRatio(x: Rgba, y: Rgba): number {
	const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
	return (hi! + 0.05) / (lo! + 0.05)
}
/** `top` painted over an opaque `bottom` — source-over in gamma space, as browsers composite. */
export function over(top: Rgba, bottom: Rgba): Rgba {
	const a = top.a
	return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 }
}

// ── Themes: contract, contrast, distance ────────────────────────────────────────────────────────────────
// Contract v2, as src/themes/*.css headers state it and all six shipped presets satisfy it (45 :root
// variables, 26 of them redefined in .dark). The fork STAMP (ADR-085 §E) joins this check with presetGen in
// P6a, which defines what the stamp hashes; until then no project can hold a fork, so there is none to verify.
export const CONTRACT_BOTH = [
	...['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary', 'primary-foreground'],
	...['secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive'],
	...['destructive-foreground', 'border', 'input', 'ring', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'],
	...['shadow-color', 'shadow-opacity'],
]
export const CONTRACT_ROOT = [
	...['preset', 'radius', 'section-y', 'section-y-lg', 'hero-y', 'nav-h', 'font-sans', 'font-serif', 'font-mono'],
	...['tracking-display', 'leading-display', 'sidebar', 'sidebar-foreground', 'sidebar-primary', 'sidebar-primary-foreground'],
	...['sidebar-accent', 'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring'],
]

/** A theme's custom properties by mode (names without `--`). `.dark` is the template's switch (a class on
 *  <html>); a `prefers-color-scheme: dark` block is kept apart because the app's toggle cannot reach it. */
export interface ThemeVars {
	root: Record<string, string>
	dark: Record<string, string>
	mediaDark: Record<string, string>
}

export function parseThemeVars(css: string): ThemeVars {
	const out: ThemeVars = { root: {}, dark: {}, mediaDark: {} }
	const decls = (body: string) => {
		const flat = body.replace(/\{[^{}]*\}/g, '') // drop nested rules; only this block's own declarations
		return Object.fromEntries([...flat.matchAll(/--([\w-]+)\s*:\s*([^;]*)/g)].map((m) => [m[1]!, m[2]!.trim()]))
	}
	const walk = (src: string, darkMedia: boolean) => {
		for (let i = 0; i < src.length; ) {
			const open = src.indexOf('{', i)
			if (open < 0) break
			let depth = 1
			let j = open + 1
			for (; j < src.length && depth > 0; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0
			const prelude = src.slice(i, open)
			const head = prelude.slice(prelude.lastIndexOf(';') + 1).trim()
			const body = src.slice(open + 1, j - 1)
			if (head.startsWith('@')) walk(body, darkMedia || /prefers-color-scheme\s*:\s*dark/.test(head))
			for (const sel of head.startsWith('@') ? [] : head.split(',').map((s) => s.trim())) {
				if (/^(?::root|html)$/.test(sel)) Object.assign(darkMedia ? out.mediaDark : out.root, decls(body))
				else if (/^(?::root|html)?\.dark(?::root)?$/.test(sel)) Object.assign(out.dark, decls(body))
			}
			i = j
		}
	}
	walk(stripComments(css), false)
	return out
}

/** A variable's value in one mode, var() references followed (dark falls back to :root, like the cascade). */
export function themeValue(v: ThemeVars, mode: 'light' | 'dark', name: string, depth = 0): string | undefined {
	const raw = (mode === 'dark' ? v.dark[name] : undefined) ?? v.root[name]
	if (raw === undefined || depth > 8) return undefined
	return raw.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, n: string, fb?: string) => themeValue(v, mode, n, depth + 1) ?? fb?.trim() ?? '')
}
const themeColor = (v: ThemeVars, mode: 'light' | 'dark', name: string) => {
	const s = themeValue(v, mode, name)
	return s === undefined ? null : parseColor(s)
}

export interface ThemeContractReport {
	ok: boolean
	preset?: string
	missingRoot: string[]
	missingDark: string[]
	/** Color roles whose value does not resolve to a color (in either mode). */
	unparseable: string[]
	darkVia: 'class' | 'media' | 'none'
}

export function themeContract(css: string): ThemeContractReport {
	const v = parseThemeVars(css)
	const missingRoot = [...CONTRACT_BOTH, ...CONTRACT_ROOT].filter((n) => v.root[n] === undefined)
	const missingDark = CONTRACT_BOTH.filter((n) => v.dark[n] === undefined)
	const colorRoles = CONTRACT_BOTH.filter((n) => n !== 'shadow-opacity')
	const unparseable = colorRoles.filter((n) => (['light', 'dark'] as const).some((m) => v.root[n] !== undefined && !themeColor(v, m, n)))
	const darkVia = Object.keys(v.dark).length ? 'class' : Object.keys(v.mediaDark).length ? 'media' : 'none'
	const preset = v.root.preset?.replace(/^['"]|['"]$/g, '')
	return { ok: !missingRoot.length && !missingDark.length && !unparseable.length, preset, missingRoot, missingDark, unparseable, darkVia }
}

// Text pairs a preset promises readable at 4.5:1, and UI pairs at 3:1 (WCAG 1.4.11: a focus ring must stand
// off the page). Border/input stay out: hairlines are decorative by design. `primary` is a TEXT color too —
// the template paints Section eyebrows, links and active states with text-primary — so it is held to 4.5:1 on
// every surface it lands on (measured: a fill-only CTA red, 3.0–3.7:1 as text, failed four eyebrows per page).
const TEXT_PAIRS: [string, string][] = [
	['foreground', 'background'], ['card-foreground', 'card'], ['popover-foreground', 'popover'],
	['primary-foreground', 'primary'], ['secondary-foreground', 'secondary'], ['muted-foreground', 'muted'],
	['muted-foreground', 'background'], ['accent-foreground', 'accent'], ['destructive-foreground', 'destructive'],
	['primary', 'background'], ['primary', 'card'], ['primary', 'muted'],
	// …and so is `destructive`: form validation messages are text-destructive (a checkout form's errors).
	['destructive', 'background'], ['destructive', 'card'],
]
const UI_PAIRS: [string, string][] = [['ring', 'background']]

export interface PairResult {
	mode: 'light' | 'dark'
	fg: string
	bg: string
	ratio: number
	min: number
	ok: boolean
}

/** Each pair in both modes, translucent values composited over the mode's own background first. */
export function themeContrast(css: string): { pairs: PairResult[]; failures: number } {
	const v = parseThemeVars(css)
	const pairs: PairResult[] = []
	for (const mode of ['light', 'dark'] as const) {
		const page = themeColor(v, mode, 'background')
		if (!page) continue
		const base = over(page, mode === 'dark' ? { r: 0, g: 0, b: 0, a: 1 } : { r: 1, g: 1, b: 1, a: 1 })
		for (const [list, min] of [[TEXT_PAIRS, 4.5], [UI_PAIRS, 3]] as const) {
			for (const [fg, bg] of list) {
				const b = themeColor(v, mode, bg)
				const f = themeColor(v, mode, fg)
				if (!b || !f) continue
				const back = over(b, base)
				const ratio = Math.round(contrastRatio(over(f, back), back) * 100) / 100
				pairs.push({ mode, fg, bg, ratio, min, ok: ratio >= min })
			}
		}
	}
	return { pairs, failures: pairs.filter((p) => !p.ok).length }
}

/** sRGB → OKLab (Björn Ottosson's matrices), for perceptual distances. */
function toOklab(c: Rgba): [number, number, number] {
	const [r, g, b] = [linear(c.r), linear(c.g), linear(c.b)]
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
	return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

// The roles a viewer actually SEES as the theme's personality (charts and sidebar are secondary surfaces).
const DISTANCE_ROLES = ['background', 'foreground', 'card', 'primary', 'primary-foreground', 'secondary', 'muted', 'muted-foreground', 'accent', 'border', 'ring']

/** Mean OKLab ΔE (×100, so ~2 is a just-noticeable difference) over the visible roles in both modes.
 *  0 = the same palette. NaN when the two share no resolvable role. */
export function themeDistance(a: string, b: string): number {
	const va = parseThemeVars(a)
	const vb = parseThemeVars(b)
	const ds: number[] = []
	for (const mode of ['light', 'dark'] as const) {
		const back = (v: ThemeVars) => over(themeColor(v, mode, 'background') ?? { r: 1, g: 1, b: 1, a: 1 }, { r: 1, g: 1, b: 1, a: 1 })
		for (const role of DISTANCE_ROLES) {
			const ca = themeColor(va, mode, role)
			const cb = themeColor(vb, mode, role)
			if (!ca || !cb) continue
			const [p, q] = [toOklab(over(ca, back(va))), toOklab(over(cb, back(vb)))]
			ds.push(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100)
		}
	}
	return ds.length ? Math.round((ds.reduce((x, y) => x + y, 0) / ds.length) * 10) / 10 : Number.NaN
}

/** The shipped preset a theme is closest to — "is this fork a new look, or premium with one hue moved?" */
export function nearestPreset(css: string, presets: { name: string; css: string }[]): { name: string; distance: number } | undefined {
	return presets
		.map((p) => ({ name: p.name, distance: themeDistance(css, p.css) }))
		.filter((p) => !Number.isNaN(p.distance))
		.sort((x, y) => x.distance - y.distance)[0]
}
