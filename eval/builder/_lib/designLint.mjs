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
	const rawShade = bundle.match(/\b(?:bg|text|border|from|to|ring|fill|stroke)-(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})\b/g)
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
	const emoji = bundle.match(/[\u{1F300}-\u{1FAFF}]/gu) ?? []
	if (emoji.length >= 4) return `${emoji.length} emoji codepoints in the bundle — emoji-as-image is banned; use <ArtImage> or the photo pack`
	return null
}

/** Positive control: token utilities present at all (guards against a check running on the wrong dist). */
export function tokenBaseline(bundle) {
	if (!bundle.includes('bg-background') || !bundle.includes('text-muted-foreground')) return 'token utilities absent from bundle — is this the right build?'
	return null
}

/** Run a set of lint fns; print each failure; return count. */
export function runDesignLint(bundle, { blocks = [] } = {}) {
	const failures = [tokenBaseline(bundle), noRawColors(bundle), usesImagery(bundle), blocks.length ? usesBlocks(bundle, blocks) : null].filter(Boolean)
	for (const f of failures) console.error(`design-lint: ${f}`)
	return failures.length
}
