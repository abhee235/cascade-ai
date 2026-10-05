// scripts/ui-audit/audit.mjs — ADR-084 Phase 0. The repeatable UI audit for CASCADE'S OWN web UI.
//
//   node scripts/ui-audit/audit.mjs [--url http://localhost:5319] [--theme light|dark] [--json]
//
// Requires the web UI to be running (packages/web: npm run dev) and the ws server on 4319, because the
// numbers that matter — computed contrast, real font sizes, hit areas — exist only in a rendered DOM.
// Opt-in by design (ADR-084 Consequences): never part of `vitest run`.
//
// TWO SANITY ASSERTIONS ARE LOAD-BEARING (ADR-084 §Method). Both were learned the hard way:
//   1. Tailwind v4 emits `oklch()`. getComputedStyle returns it verbatim and canvas does NOT normalise it,
//      so a naive rgb() parse silently returns ratio 1.0 for EVERY pair — which reads as a catastrophic
//      finding rather than a broken script. We assert white-on-black === 21 and that an oklch pair resolves.
//   2. Programmatic .focus() never triggers :focus-visible, so focus must be probed with a real Tab press.
// If an assertion fails we ABORT. A silent audit that fabricates failures is worse than no audit.

import { chromium } from 'playwright-core'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('url', 'http://localhost:5319').replace(/\/$/, '')
const THEME = arg('theme', 'light')
const AS_JSON = process.argv.includes('--json')

// The builder is the densest surface in the app and the one most likely to drift, but it needs a real
// project to render. Pass --project <slug> to include it; without one it is skipped rather than faked.
const PROJECT = arg('project', null)

const ROUTES = [
  { path: '/', name: 'home' },
  { path: '/projects', name: 'projects' },
  { path: '/chats', name: 'chats' },
  { path: '/mcp', name: 'connectors' },
  { path: '/settings', name: 'settings' },
  { path: '/observatory', name: 'observatory' },
  ...(PROJECT ? [{ path: `/project/${PROJECT}`, name: 'builder' }] : []),
]

/** Launch order mirrors browserTool.ts: a shipped Chromium if present, else the system browsers. */
async function launch() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    try { return await chromium.launch({ headless: true }) } catch { /* wrong revision — fall through */ }
  }
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel, headless: true }) } catch { /* not installed */ }
  }
  throw new Error('No browser available (tried bundled Chromium, Edge, Chrome).')
}

/** Everything below runs IN THE PAGE. Kept in one function so the injected source stays reviewable. */
function inPage() {
  const srgb = (x) => { const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return Math.max(0, Math.min(1, v)) * 255 }
  const oklchToRGB = (L, C, H) => {
    const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h)
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
    return [srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            srgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)]
  }
  const parse = (c) => {
    if (!c) return null
    const o = c.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i)
    if (o) { let L = parseFloat(o[1]); if (o[1].includes('%')) L /= 100; return oklchToRGB(L, parseFloat(o[2]), parseFloat(o[3])) }
    const h = c.match(/^#([0-9a-f]{6})$/i)
    if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16))
    const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
    return m ? [+m[1], +m[2], +m[3]] : null
  }
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const ratio = (fg, bg) => { const A = parse(fg), B = parse(bg); if (!A || !B) return null; const a = lum(A), b = lum(B); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
  const bgOf = (el) => { let n = el; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba?\(0, 0, 0, 0\)|transparent/.test(b)) return b; n = n.parentElement } return getComputedStyle(document.body).backgroundColor }

  // ── SANITY (abort the whole run if these are wrong; see the header) ──
  const sanity = {
    whiteOnBlack: +ratio('rgb(255,255,255)', 'rgb(0,0,0)').toFixed(2),
    oklchResolves: !!parse('oklch(0.985 0 0)') && Math.round(parse('oklch(0.985 0 0)')[0]) > 240,
  }

  const els = [...document.querySelectorAll('*')].filter((e) => !e.children.length && e.textContent.trim().length > 1 && e.offsetParent)
  const sizes = {}, contrast = []
  let widestChars = 0
  for (const el of els) {
    const cs = getComputedStyle(el), px = parseFloat(cs.fontSize)
    sizes[px] = (sizes[px] || 0) + 1
    const chars = Math.round(el.getBoundingClientRect().width / (px * 0.5))
    if (el.textContent.trim().length > 60 && chars > widestChars) widestChars = chars
    const r = ratio(cs.color, bgOf(el))
    if (r === null) continue
    const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight) >= 700)
    if (r < (large ? 3 : 4.5)) contrast.push({ text: el.textContent.trim().slice(0, 32), px, ratio: +r.toFixed(2), need: large ? 3 : 4.5 })
  }
  const controls = [...document.querySelectorAll('button,a[href],input,textarea,select,[role="button"]')].filter((e) => e.offsetParent)
  // EFFECTIVE hit area, not the painted box — measured in two independent ways, because each alone lies:
  //
  //  (a) getBoundingClientRect() cannot see an `::after` overlay, the standard way to grow a target without
  //      growing the icon (the shadcn sidebar pattern). Box-only under-credits real fixes.
  //  (b) elementFromPoint() sees occlusion — it is what caught a wider drag-rail swallowing the delete
  //      buttons underneath it — but it returns null for ANY point outside the viewport, so on a scrolled
  //      list it silently marks every off-screen control as too small.
  //
  // So: expand the box by any absolutely-positioned `::after` with negative insets (viewport-independent),
  // and only additionally require the point test when the control is actually on screen.
  const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : 0)
  const effective = (e) => {
    const r = e.getBoundingClientRect()
    const af = getComputedStyle(e, '::after')
    if (af && af.content && af.content !== 'none' && af.position === 'absolute') {
      const grow = (a, b) => Math.max(0, -px(a)) + Math.max(0, -px(b))
      return { w: r.width + grow(af.left, af.right), h: r.height + grow(af.top, af.bottom), r }
    }
    return { w: r.width, h: r.height, r }
  }
  const onScreen = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
  const hits = (el, x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t) || t.contains(el)) }
  const tooSmall = controls.filter((e) => {
    const { w, h, r } = effective(e)
    if (r.width === 0) return false
    if (w < 24 || h < 24) return true
    if (!onScreen(r)) return false // big enough on paper and we cannot point-test it — do not invent a failure
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = 11.5
    return !([[cx - d, cy - d], [cx + d, cy - d], [cx - d, cy + d], [cx + d, cy + d]].every(([x, y]) => hits(e, x, y)))
  })
  const describe = (e) => {
    const r = e.getBoundingClientRect()
    return { label: (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent.trim() || `<${e.tagName.toLowerCase()}>`).slice(0, 28), size: `${Math.round(r.width)}×${Math.round(r.height)}`, cls: (e.className || '').toString().replace(/\s+/g, ' ').slice(0, 70) }
  }
  const unnamed = controls.filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || e.getAttribute('title') || e.getAttribute('aria-labelledby')))
  const tiny = Object.entries(sizes).filter(([px]) => +px < 12).reduce((s, [, n]) => s + n, 0)

  return {
    sanity,
    textNodes: els.length,
    sizes: Object.entries(sizes).sort((a, b) => a[0] - b[0]).map(([px, n]) => `${px}px×${n}`).join(' '),
    tinyText: tiny,
    contrastFails: contrast.length,
    worstContrast: contrast.sort((a, b) => a.ratio - b.ratio).slice(0, 5),
    controls: controls.length,
    under24: tooSmall.length,
    unnamed: unnamed.length,
    widestChars,
    smallDetail: tooSmall.slice(0, 20).map(describe),
    unnamedDetail: unnamed.slice(0, 10).map(describe),
  }
}

/**
 * Real Tab press — the ONLY way :focus-visible engages (see header).
 *
 * The indicator is NOT always on the focused element: a composer typically paints it on the wrapper via
 * `focus-within:ring-…`. Checking only the focused node reports a false MISSING and invites someone to add
 * a second, redundant ring. So measure by DIFFERENCE: snapshot the element and its ancestors while focused,
 * blur, snapshot again — any change in outline/box-shadow/border means focus is genuinely indicated.
 */
async function focusProbe(page) {
  await page.keyboard.press('Tab')
  return page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { tabbed: false }
    const chain = []
    for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) chain.push(n)
    const snap = () => chain.map((n) => { const c = getComputedStyle(n); return `${c.outlineStyle}|${c.outlineWidth}|${c.boxShadow}|${c.borderColor}` })
    const focused = snap()
    const target = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() || `<${el.tagName.toLowerCase()}>`).slice(0, 40)
    const focusVisible = (() => { try { return el.matches(':focus-visible') } catch { return null } })()
    el.blur()
    const blurred = snap()
    const changedAt = focused.findIndex((v, i) => v !== blurred[i])
    return {
      tabbed: true,
      target,
      focusVisible,
      hasIndicator: changedAt !== -1,
      indicatedOn: changedAt === -1 ? null : changedAt === 0 ? 'self' : `ancestor+${changedAt}`,
    }
  })
}

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const results = []
let aborted = null

for (const route of ROUTES) {
  await page.goto(BASE + route.path, { waitUntil: 'domcontentloaded' })
  if (THEME) await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), THEME)
  await page.waitForTimeout(600) // let the SPA paint
  const r = await page.evaluate(inPage)

  if (r.sanity.whiteOnBlack !== 21 || !r.sanity.oklchResolves) {
    aborted = `SANITY FAILED on ${route.path}: whiteOnBlack=${r.sanity.whiteOnBlack} (expected 21), oklchResolves=${r.sanity.oklchResolves}.\n` +
      'The contrast function is broken — every ratio it reports is meaningless. Refusing to emit numbers.'
    break
  }
  const focus = await focusProbe(page)
  results.push({ route: route.name, path: route.path, ...r, focus })
}
await browser.close()

if (aborted) { console.error(aborted); process.exit(2) }

if (AS_JSON) { console.log(JSON.stringify({ base: BASE, theme: THEME, results }, null, 2)); process.exit(0) }

const pad = (s, n) => String(s).padEnd(n)
console.log(`\nADR-084 UI audit — ${BASE}  theme=${THEME}  (sanity OK: white-on-black 21:1, oklch resolves)\n`)
console.log(`| ${pad('route', 12)} | ${pad('nodes', 5)} | ${pad('<12px', 5)} | ${pad('contrast', 8)} | ${pad('controls', 8)} | ${pad('<24px', 5)} | ${pad('unnamed', 7)} | focus |`)
console.log(`|${'-'.repeat(14)}|${'-'.repeat(7)}|${'-'.repeat(7)}|${'-'.repeat(10)}|${'-'.repeat(10)}|${'-'.repeat(7)}|${'-'.repeat(9)}|-------|`)
for (const r of results) {
  console.log(`| ${pad(r.route, 12)} | ${pad(r.textNodes, 5)} | ${pad(r.tinyText, 5)} | ${pad(r.contrastFails, 8)} | ${pad(r.controls, 8)} | ${pad(r.under24, 5)} | ${pad(r.unnamed, 7)} | ${pad(r.focus.hasIndicator ? 'ok' : 'MISSING', 5)} |`)
}
const totals = results.reduce((a, r) => ({ tiny: a.tiny + r.tinyText, cf: a.cf + r.contrastFails, small: a.small + r.under24, un: a.un + r.unnamed }), { tiny: 0, cf: 0, small: 0, un: 0 })
console.log(`\nTOTals  <12px:${totals.tiny}  contrastFails:${totals.cf}  <24px:${totals.small}  unnamed:${totals.un}`)
for (const r of results) {
  if (!r.worstContrast.length) continue
  console.log(`\n${r.route}: worst contrast`)
  for (const c of r.worstContrast) console.log(`   ${c.ratio} (need ${c.need})  ${c.px}px  "${c.text}"`)
}
for (const r of results) {
  if (r.focus.tabbed && !r.focus.hasIndicator) {
    console.log(`\n${r.route}: FIRST TAB HAS NO VISIBLE FOCUS — target "${r.focus.target}" (focusVisible=${r.focus.focusVisible}, outline=${r.focus.outline})`)
  }
}
if (process.argv.includes('--detail')) {
  for (const r of results) {
    if (r.smallDetail.length) {
      console.log(`\n${r.route}: controls under 24x24`)
      for (const d of r.smallDetail) console.log(`   ${pad(d.size, 7)} ${pad(d.label, 28)} ${d.cls}`)
    }
    if (r.unnamedDetail.length) {
      console.log(`\n${r.route}: controls with NO accessible name`)
      for (const d of r.unnamedDetail) console.log(`   ${pad(d.size, 7)} ${d.cls}`)
    }
  }
}
console.log('')
