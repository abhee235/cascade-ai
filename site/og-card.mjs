// Renders og-card.html → public/assets/og-cover.png at exactly 1200x630.
//
//   cd site && node og-card.mjs
//
// Uses playwright-core from the monorepo root with the locally installed Chrome/Edge, so this adds no
// dependency to site/ (which ships nothing but wrangler). deviceScaleFactor stays at 1: the OG spec wants
// 1200x630 actual pixels, and a 2x shot would be a 2400x1260 file that some scrapers reject on size.
import { chromium } from '../node_modules/playwright-core/index.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'public', 'assets', 'og-cover.png')

// Whichever of these is installed wins. playwright-core ships no browser of its own, so without a channel
// it would throw "Executable doesn't exist" rather than fall back.
let browser
for (const channel of ['chrome', 'msedge', 'chromium']) {
	try {
		browser = await chromium.launch({ channel })
		console.log(`launched: ${channel}`)
		break
	} catch {
		/* try the next channel */
	}
}
if (!browser) throw new Error('No Chrome/Edge/Chromium found. Install one, or run: npx playwright install chromium')

const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(here, 'og-card.html')).href, { waitUntil: 'load' })

// The card's type IS the design, so a webfont that has not arrived yet would silently render the card in
// the system fallback at different metrics. Wait for the actual faces, then assert Geist really loaded.
await page.evaluate(() => document.fonts.ready)
const geist = await page.evaluate(() => document.fonts.check('700 112px Geist'))
if (!geist) throw new Error('Geist did not load — card would render in a fallback face. Check network.')

await page.screenshot({ path: out, type: 'png' })
await browser.close()
console.log(`wrote ${out}`)
