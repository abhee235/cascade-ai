// eval/builder/_lib/designLint.mjs — OBJECTIVE design assertions over the built bundle (design-system
// v2). Shared by scenario checks (this dir has no scenario.json, so the runner never treats it as a
// scenario). Same character as the existing checks: exact-substring/regex facts about dist output —
// no taste judgments, so the measurement can't be overfitted to a screenshot.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** All built JS, joined (the existing idiom — Tailwind class names and data-attrs survive minification). */
export function readBundleJs() {
	return readdirSync(join('dist', 'assets'))
		.filter((f) => f.endsWith('.js'))
		.map((f) => readFileSync(join('dist', 'assets', f), 'utf8'))
		.join('\n')
}

/** Raw-color utilities are design-system violations: the tokens exist precisely so these never appear. */
export function noRawColors(bundle) {
	// THE MODAL SCRIM IS NOT A VIOLATION. shadcn's Dialog/AlertDialog/Sheet/Drawer overlays ship
	// `bg-black/50`, and that is CORRECT: a scrim must darken in BOTH themes, so a token would invert it
	// to a white veil in dark mode. This lint reads the bundle, which cannot tell vendored kit from app
	// code — so the opacity-suffixed black is stripped before scanning. A bare `bg-black` still fails.
	// (Found 2026-08-13 by builder-appshell, whose brief requires a confirm dialog: the kit's own scrim
	// failed the fixture's own solution.)
	const scanned = bundle.replace(/\bbg-black\/\d{1,3}\b/g, '')
	const rawShade = scanned.match(/\b(?:bg|text|border|from|to|ring|fill|stroke)-(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})\b/g)
	const arbitraryHex = bundle.match(/\b(?:bg|text|border)-\[#[0-9a-fA-F]{3,8}\]/g)
	const hits = [...new Set([...(rawShade ?? []), ...(arbitraryHex ?? [])])]
	if (hits.length > 0) return `raw color utilities in the bundle (use tokens): ${hits.slice(0, 8).join(', ')}`
	return null
}

/** Pages must be assembled from blocks — each block stamps data-block="<name>" on its root. */
export function usesBlocks(bundle, names) {
	const missing = names.filter((n) => !bundle.includes(`data-block="${n}"`) && !bundle.includes(`"data-block":"${n}"`))
	if (missing.length > 0) return `page not assembled from blocks — missing: ${missing.join(', ')} (import from @/components/blocks)`
	return null
}

/** Real imagery required: ArtImage (data-art) or the photo pack; emoji-as-image is the anti-pattern. */
export function usesImagery(bundle) {
	const hasArt = bundle.includes('data-art') || bundle.includes('"data-art"')
	const hasPhotos = /assets\/[\w-]+-[\w]+\.webp|photoFor|photos\.ts/.test(bundle)
	if (!hasArt && !hasPhotos) return 'no real imagery in the bundle — use <ArtImage> or photo()/photoFor() from @/lib/photos'
	const emoji = bundle.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu) ?? []
	if (emoji.length >= 4) return `${emoji.length} emoji codepoints in the bundle — emoji-as-image is banned; use <ArtImage> or the photo pack`
	return null
}

/** The half of usesImagery that applies EVERYWHERE, including surfaces with no photography: an emoji is
 *  never an image. A dashboard opting out of "must contain a photo" does not get to render 📊 as a chart. */
export function noEmojiAsImage(bundle) {
	const emoji = bundle.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu) ?? []
	if (emoji.length >= 4) return `${emoji.length} emoji codepoints in the bundle — emoji-as-image is banned; use lucide icons, <ArtImage>, or the photo pack`
	return null
}

/** Positive control: token utilities present at all (guards against a check running on the wrong dist). */
export function tokenBaseline(bundle) {
	if (!bundle.includes('bg-background') || !bundle.includes('text-muted-foreground')) return 'token utilities absent from bundle — is this the right build?'
	return null
}

/** The ACTIVE PRESET, asserted from built CSS: every preset declares `--preset:'<name>'` (contract v2).
 *  This is how "the model applied the preset the plan asked for" becomes an objective fact. */
export function presetApplied(name) {
	const css = readdirSync(join('dist', 'assets'))
		.filter((f) => f.endsWith('.css'))
		.map((f) => readFileSync(join('dist', 'assets', f), 'utf8'))
		.join('\n')
	// CSS minifiers drop spaces and may keep either quote style.
	// `'*'` asserts only that SOME preset is active. Use it when the brief does not name a look: which
	// preset suits an app is taste, and a fixture that demands one would fail correct work from a model
	// that chose a defensible different one. What is objective is that a preset is applied at all.
	if (name === '*') {
		if (!/--preset:\s*['"][a-z-]+['"]/.test(css)) return 'no preset fingerprint in the built CSS — src/index.css must @import one file from src/themes/'
		return null
	}
	if (!new RegExp(`--preset:\\s*['"]${name}['"]`).test(css)) return `preset "${name}" not applied — edit the ONE @import line in src/index.css to ./themes/${name}.css`
	return null
}

// ── SOURCE-side checks: minification destroys the evidence, so these read src/, not dist. ───────────────
const VENDORED_KIT = join('src', 'components', 'ui') // the shadcn kit is not the model's styling

function readSrc(dir = 'src', out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name)
		if (e.isDirectory()) {
			// Path-based, not name-based: an app's own src/features/*/ui/ must still be checked.
			if (e.name !== 'node_modules' && p !== VENDORED_KIT) readSrc(p, out)
		} else if (/\.tsx?$/.test(e.name)) out.push({ path: p, text: readFileSync(p, 'utf8') })
	}
	return out
}

/** The "why do all my products look like the same watch?" bug, measured: photoFor() inside a list render
 *  repeats the ~2-per-category pack across every card. Grids must use <Photo web=… seed=…>. */
export function photoDistinct(files = readSrc()) {
	for (const f of files) {
		const lines = f.text.split('\n')
		const at = lines.findIndex((l, i) => /photoFor\(/.test(l) && lines.slice(Math.max(0, i - 6), i + 1).some((p) => /\.map\(/.test(p)))
		if (at >= 0) return `${f.path}:${at + 1} photoFor() inside a list render — every card repeats; use <Photo web="<subject>" seed={item.id}>`
	}
	return null
}

// ONE-PRIMARY-CTA: attempted as an assertion and REMOVED (2026-08-11). A per-file count of
// variant-less <Button>s flagged the shop solution's CartView, which has three — "Keep browsing",
// "Checkout", "Place order" — in MUTUALLY EXCLUSIVE render branches (confirmed / cart / checkout form).
// The rule is "one primary per SCREENFUL", and which buttons share a screen is a runtime fact this
// file cannot know. A check that fails correct code is worse than no check: models learn to work around
// the bar instead of meeting it. So it stays PROSE (design skill §4) + screenshot review — the repo's
// standing rule that an unassertable rule never becomes a lint.

/** Run a set of lint fns; print each failure; return count.
 *  `preset` asserts the active theme; `quality: true` adds the source-side judgment checks (the 35B bar —
 *  the 9B integrity floor runs without them; see the eval bar split). */
export function runDesignLint(bundle, { blocks = [], preset, quality = false, imagery = true } = {}) {
	const failures = [
		tokenBaseline(bundle),
		noRawColors(bundle),
		// `imagery: false` for app types with NO photographic surface — a dashboard is charts, KPI numbers
		// and a table, and its avatars are initials. Demanding a photo there would fail correct work, which
		// teaches models to bolt on a decorative image to satisfy the bar (the reasoning that retired
		// onePrimaryCta). The emoji half of the rule still applies to every fixture, below.
		imagery ? usesImagery(bundle) : noEmojiAsImage(bundle),
		blocks.length ? usesBlocks(bundle, blocks) : null,
		preset ? presetApplied(preset) : null,
		...(quality ? [photoDistinct()] : []),
	].filter(Boolean)
	for (const f of failures) console.error(`design-lint: ${f}`)
	return failures.length
}
