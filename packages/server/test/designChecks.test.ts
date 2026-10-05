import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACT_BOTH, CONTRACT_ROOT, contrastRatio, isOwnSource, nearestPreset, neverList, parseColor, rawColors, themeContract, themeContrast, themeDistance } from '../src/designChecks'
import { resourceDir } from '../src/resources'

// ADR-085 P0: the source half of the design instrument. Every rule below carries the case that shaped it —
// most came from running the checks over the kept 2026-09-27 six-arm workdirs.

const f = (path: string, text: string) => ({ path, text })
const notations = (text: string, path = 'src/App.tsx') => rawColors([f(path, text)]).byNotation

describe('rawColors', () => {
	it('counts every notation — a model told "no hex" writes oklch (qwen36 landing: 0 hex, 48 oklch)', () => {
		const css = [
			'.a { color: #abc; background: #abcd; border-color: #aabbcc; outline-color: #aabbcc80; }',
			'.b { color: rgb(0 0 0 / 50%); background: rgba(1, 2, 3, .5); fill: hsl(210 40% 98%); stroke: hwb(0 0% 0%); }',
			'.c { color: oklch(0.7 0.1 200); background: oklab(0.5 0.1 -0.1); border-color: lab(50 20 30); outline-color: lch(50 30 200); }',
			'.d { color: color(display-p3 1 0 0); background: tomato; --brand: navy; }',
		].join('\n')
		expect(notations(css, 'src/index.css')).toEqual({ hex: 4, rgb: 2, hsl: 1, hwb: 1, oklch: 1, oklab: 1, lab: 1, lch: 1, color: 1, named: 2 })
	})

	it('reads Tailwind arbitrary values, where _ is the space (`shadow-[0_0_10px_#d6fa6b]` was a missed hex)', () => {
		expect(notations('<i className="bg-[oklch(0.12_0.01_292)] shadow-[0_0_10px_#d6fa6b] text-[#fff]" />')).toEqual({ oklch: 1, hex: 2 })
	})

	it('counts palette and white/black utilities, exempting only the modal scrim (bg-black/NN)', () => {
		expect(notations('<i className="text-white/70 hover:bg-red-500 border-zinc-200 from-black/60 bg-black/50" />')).toEqual({ palette: 4 })
	})

	it('never counts token-derived colors — the template index.css uses oklch(from var(…)) for its shadows', () => {
		const css = ':root { --x: hsl(var(--primary)); --y: oklch(from var(--shadow-color) l c h / calc(var(--o) * 2)); --z: color-mix(in oklab, var(--ring) 50%, transparent); }'
		expect(rawColors([f('src/index.css', css)]).total).toBe(0)
	})

	it('ignores hex-looking prose: entities, anchors, ids, order numbers, comments, product data', () => {
		const tsx = [
			'<p>A&#8212;B <a href="#cafe">Café</a> <b id="#add-to-cart">x</b> Order #1042</p>',
			'// was #7c3aed, now bg-primary',
			"const tee = { name: 'Tee', color: 'Navy' }",
		].join('\n')
		expect(rawColors([f('src/App.tsx', tsx)]).total).toBe(0)
		expect(notations('<i style={{ color: "#333" }} />')).toEqual({ hex: 1 }) // …but a repeated-digit gray is a color
	})

	it('names named colors only where a color is SET: CSS, style objects, SVG/icon attributes', () => {
		expect(notations('<svg fill="white" stroke="currentColor"><p style={{ backgroundColor: "black" }}>red wine</p></svg>')).toEqual({ named: 2 })
	})

	it('treats a blank project\'s own theme file as the theme, not as raw colors (ADR-086)', () => {
		const files = [f('src/theme.css', ':root { --primary: #9a3f1e; --background: #faf7f2; }'), f('src/App.tsx', '<i className="bg-[#ff0000]" />')]
		expect(rawColors(files).total).toBe(3) // without the option the tokens would count
		expect(rawColors(files, { themeFiles: ['src/theme.css'] }).hits.map((h) => h.match)).toEqual(['#ff0000'])
	})

	it('scans only the app\'s own files, path-based (an app\'s src/features/x/ui/ is its own code)', () => {
		expect(isOwnSource('src/components/ui/button.tsx')).toBe(false)
		expect(isOwnSource('src/components/blocks/Hero.tsx')).toBe(false)
		expect(isOwnSource('src/themes/premium.css')).toBe(false)
		expect(isOwnSource('src/features/cart/ui/Row.tsx')).toBe(true)
		expect(isOwnSource('src/index.css')).toBe(true)
		expect(isOwnSource('src/vite-env.d.ts')).toBe(false)
		const r = rawColors([f('src/components/ui/button.tsx', 'bg-[#fff]'), f('src/App.tsx', 'x\ny\n<i className="bg-[#fff]" />')])
		expect(r.hits).toEqual([{ path: 'src/App.tsx', line: 3, notation: 'hex', match: '#fff' }])
	})

	it('counts what an edit ADDED to a kit or block file, now that the template is open (ADR-086 P1)', () => {
		const hero = '<section className="bg-muted text-[#123456]">x</section>' // the shipped file carries a color of its own
		const shipped = (p: string) => (p === 'src/components/blocks/Hero.tsx' ? [hero] : undefined)
		expect(rawColors([f('src/components/blocks/Hero.tsx', hero)], { shipped }).total).toBe(0) // untouched: template code
		const edited = hero.replace('x', '<b className="text-[#ff0000]">x</b>')
		expect(rawColors([f('src/components/blocks/Hero.tsx', edited)], { shipped }).hits.map((h) => h.match)).toEqual(['#ff0000']) // never the shipped one
		expect(rawColors([f('src/components/blocks/Promo.tsx', '<i className="bg-[#00ff00]" />')], { shipped }).total).toBe(1) // a block it added
		expect(rawColors([f('src/components/blocks/Promo.tsx', '<i className="bg-[#00ff00]" />')]).total).toBe(0) // no lookup: path-based
		expect(rawColors([f('src/components/blocks/Hero.tsx', `${hero}\r\n`)], { shipped: () => [`${hero}\n`] }).total).toBe(0) // CRLF is no edit
	})

	it('the never-list follows the same ownership', () => {
		const shipped = () => ['<Button>Start</Button>']
		expect(neverList([f('src/components/blocks/CTASection.tsx', '<Button>Start →</Button>')], { shipped }).map((x) => x.check)).toEqual(['arrow-cta'])
		expect(neverList([f('src/components/blocks/CTASection.tsx', '<Button>Start</Button>')], { shipped })).toEqual([])
	})
})

describe('neverList', () => {
	const checks = (text: string, path = 'src/App.tsx') => neverList([f(path, text)]).map((x) => x.check)

	it('flags glyphs standing in for icons — but an arrow inside prose is typography', () => {
		expect(checks('<span>✦</span>\n<b>★★★★★</b>\n{ icon: "✔" }\n<button>×</button>')).toEqual(['glyph-icon', 'glyph-icon', 'glyph-icon', 'glyph-icon'])
		expect(checks('<p>4,000 <span>→</span> 11</p>')).toEqual([]) // arm 3's landing: "from → to"
	})

	it('flags CTAs that END in an arrow, and an arrow span closing a button', () => {
		expect(checks('<Button>Shop now →</Button>')).toEqual(['arrow-cta'])
		expect(checks('<a href="/x">Start <span>→</span></a>')).toEqual(['arrow-cta'])
		expect(checks('<p>2,847 events → 1 incident</p>')).toEqual([])
	})

	it('flags "A · B · C" meta strings, not a single separator', () => {
		expect(checks('<p>Free to start · No credit card · Ready in minutes</p>')).toEqual(['dot-meta'])
		expect(checks("<p>{items.join(' · ')}</p>")).toEqual(['dot-meta'])
		expect(checks('<p>4.8 · 120 reviews</p>')).toEqual([])
	})

	it('flags real brands as standalone items near a customer word — not integrations or prose', () => {
		expect(checks("const CUSTOMERS = ['Stripe', 'Vercel', 'Shopify']")).toEqual(['brand-wall']) // qwen36 landing
		expect(checks(`<LogoStrip label="Trusted by teams who ship" items={['Northstar', 'Vercel', 'Linear']} />`)).toEqual(['brand-wall'])
		expect(checks("features: ['Unlimited projects', 'Slack, Linear & GitHub']")).toEqual([]) // a pricing tier (Luna)
		expect(checks("description: 'For teams running customer-facing services.', features: ['Slack', 'GitHub']")).toEqual([])
	})

	it('flags keyword/random photos, and says when one is the hero — the helpers\' own module is exempt', () => {
		expect(checks('<Hero title="x" media={<Photo web="coffee beans" />} />')).toEqual(['keyword-hero-photo'])
		expect(checks('<Card><Photo web="coffee beans" /></Card>')).toEqual(['keyword-photo'])
		expect(checks('<Hero media={<Photo web="https://images.example.com/a.jpg" />} />')).toEqual([])
		expect(checks('export function webPhoto(k) { return `https://loremflickr.com/${k}` }', 'src/lib/photos.ts')).toEqual([])
	})
})

describe('color math', () => {
	const near = (v: string, r: number, g: number, b: number) => {
		const c = parseColor(v)!
		expect([c.r * 255, c.g * 255, c.b * 255].map(Math.round)).toEqual([r, g, b])
	}

	it('converts every notation to sRGB (reference values from the CSS Color 4 spec)', () => {
		near('#f80', 255, 136, 0)
		near('rgb(255 0 0 / 50%)', 255, 0, 0)
		near('hsl(120 100% 50%)', 0, 255, 0)
		near('hwb(240 0% 0%)', 0, 0, 255)
		near('oklch(0.62796 0.25768 29.2339)', 255, 0, 0)
		near('oklab(0.62796 0.22486 0.12585)', 255, 0, 0)
		near('lab(54.29 80.8 69.89)', 255, 0, 0)
		near('lch(54.29 106.84 40.85)', 255, 0, 0)
		near('color(srgb 0 0.5 1)', 0, 128, 255)
		near('rebeccapurple', 102, 51, 153)
		near('oklch(1 0 0)', 255, 255, 255)
		expect(parseColor('#ffffff80')!.a).toBeCloseTo(0.5, 2)
		expect(parseColor('transparent')!.a).toBe(0)
		expect(parseColor('var(--primary)')).toBeNull()
	})

	it('computes WCAG contrast', () => {
		expect(contrastRatio(parseColor('#fff')!, parseColor('#000')!)).toBeCloseTo(21, 5)
		expect(contrastRatio(parseColor('#777')!, parseColor('#777')!)).toBe(1)
		expect(contrastRatio(parseColor('#767676')!, parseColor('#fff')!)).toBeCloseTo(4.54, 2) // the canonical AA gray
	})
})

describe('theme checks', () => {
	const themesDir = resourceDir('templates', 'react', 'src', 'themes')
	const presets = readdirSync(themesDir).filter((n) => n.endsWith('.css')).map((n) => ({ name: n.replace(/\.css$/, ''), css: readFileSync(join(themesDir, n), 'utf8') }))

	it('the contract is exactly what the template consumes (index.css @theme) plus the --preset fingerprint', () => {
		const indexCss = readFileSync(resourceDir('templates', 'react', 'src', 'index.css'), 'utf8')
		// Defined HERE = given a value by index.css itself; `--x: var(--x)` is a pass-through the preset fills.
		const defined = new Set([...indexCss.matchAll(/^\s*--([\w-]+)\s*:\s*([^;]*);/gm)].filter((m) => m[2]!.trim() !== `var(--${m[1]})`).map((m) => m[1]!))
		const consumed = new Set([...indexCss.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]!).filter((n) => !defined.has(n)))
		expect([...new Set([...CONTRACT_BOTH, ...CONTRACT_ROOT])].sort()).toEqual([...consumed, 'preset'].sort())
	})

	it('every shipped preset satisfies the contract in :root and .dark', () => {
		expect(presets).toHaveLength(6)
		for (const p of presets) expect(themeContract(p.css), p.name).toMatchObject({ ok: true, preset: p.name, darkVia: 'class' })
	})

	it('reports a theme with no dark block — arm 3\'s finished-looking themes fail exactly here', () => {
		const lightOnly = presets[0]!.css.replace(/\.dark\s*\{[^}]*\}/, '')
		expect(themeContract(lightOnly)).toMatchObject({ ok: false, missingRoot: [], missingDark: CONTRACT_BOTH, darkVia: 'none' })
		// A media-query dark theme is reported as such — and still fails: the app's dark toggle cannot reach it.
		expect(themeContract(lightOnly.replace(':root {', '@media (prefers-color-scheme: dark) { :root { --x: 1; } }\n:root {'))).toMatchObject({ ok: false, darkVia: 'media' })
	})

	it('measures contrast per mode, compositing translucent roles over the page', () => {
		const t = ':root { --background: #fff; --foreground: #111; --primary: #fff; --primary-foreground: #fff; } .dark { --background: #000; --foreground: rgb(255 255 255 / 10%); }'
		const failing = themeContrast(t).pairs.filter((p) => !p.ok).map((p) => `${p.mode}:${p.fg}/${p.bg}`)
		expect(failing).toEqual(['light:primary-foreground/primary', 'light:primary/background', 'dark:foreground/background', 'dark:primary-foreground/primary'])
	})

	it('measures distance between palettes — 0 for a preset against itself', () => {
		expect(themeDistance(presets[0]!.css, presets[0]!.css)).toBe(0)
		expect(themeDistance(presets[0]!.css, presets[1]!.css)).toBeGreaterThan(1)
		expect(nearestPreset(presets[2]!.css, presets)).toEqual({ name: presets[2]!.name, distance: 0 })
	})
})
