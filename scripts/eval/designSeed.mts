// designSeed.mts — install an ADR-085 P0 oracle seed into a bench workdir. Bench-only: the product never seeds.
//
// The oracle asks one question: does a finished designer theme (B), and then its written direction (C), lift
// a local model's output inside the template, against the parity baseline (A)? A seed changes exactly this:
//   1. BEFORE createSession — src/themes/<id>.css, its fonts + OFL licenses in src/assets/fonts/, and the one
//      @import line in src/index.css, so Restyle's preset list (read at creation) already includes the seed.
//   2. C only — DESIGN.md at the project root, and appended to AI_RULES.md: the product's own channel for a
//      project's rules (readAiRules → the builder's instructions), so no session option differs from A/B.
//   3. AFTER the plan stage — PLAN.md's `preset:` points at the seed (the planner defaults to premium; P1's
//      applyPlanDesign() makes the server own this choice in the product as well).
//   4. After the check — the preset the BUILT css carries, so a run that drifted back to premium is detected.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface DesignSeed {
	id: string
	scenario: string
	dir: string
	theme: string
	/** Font files and their licenses, relative to the seed dir; all land in src/assets/fonts/. */
	fonts: string[]
	brief?: string
}

/** The seed for `scenario` under `root` (`<root>/<scenario>/seed.json`), or undefined when it has none. */
export function loadSeed(root: string, scenario: string): DesignSeed | undefined {
	const file = join(root, scenario, 'seed.json')
	if (!existsSync(file)) return undefined
	const s = JSON.parse(readFileSync(file, 'utf8'))
	return { id: s.id, scenario: s.scenario, dir: join(root, scenario), theme: s.theme, fonts: s.fonts ?? [], brief: s.brief }
}

const THEME_IMPORT = /@import\s+['"]\.\/themes\/[^'"]+\.css['"];?/

export function installSeed(work: string, seed: DesignSeed, withBrief: boolean): void {
	writeFileSync(join(work, 'src', 'themes', `${seed.id}.css`), readFileSync(join(seed.dir, seed.theme), 'utf8'))
	const fonts = join(work, 'src', 'assets', 'fonts')
	mkdirSync(fonts, { recursive: true })
	for (const f of seed.fonts) copyFileSync(join(seed.dir, f), join(fonts, basename(f)))
	const indexCss = join(work, 'src', 'index.css')
	const css = readFileSync(indexCss, 'utf8')
	if (!THEME_IMPORT.test(css)) throw new Error('src/index.css has no theme @import line to point at the seed')
	writeFileSync(indexCss, css.replace(THEME_IMPORT, `@import './themes/${seed.id}.css';`))
	if (!withBrief) return
	if (!seed.brief) throw new Error(`seed "${seed.id}" has no brief for the C arm`)
	const brief = readFileSync(join(seed.dir, seed.brief), 'utf8').trim()
	writeFileSync(join(work, 'DESIGN.md'), `${brief}\n`)
	const rules = join(work, 'AI_RULES.md')
	const prior = existsSync(rules) ? `${readFileSync(rules, 'utf8').trimEnd()}\n\n` : ''
	writeFileSync(rules, `${prior}## This project's design direction (also in DESIGN.md)\n\n${brief}\n`)
}

// `preset: premium`, `preset: \`premium\``, `**preset:** premium` — planners write all three.
const PLAN_PRESET = /(?:\*\*)?\bpreset:[\s`'"*]*[\w-]+[`'"*]*/g

/** Point PLAN.md's Design line at the seed: rewrite every preset token, or insert one after `category:`. */
export function pinPlanPreset(work: string, id: string): 'rewritten' | 'inserted' | 'no-plan' {
	const file = join(work, 'PLAN.md')
	if (!existsSync(file)) return 'no-plan'
	const text = readFileSync(file, 'utf8')
	if (new RegExp(PLAN_PRESET.source).test(text)) { // a non-global copy: .test() on a /g regex is stateful
		writeFileSync(file, text.replace(PLAN_PRESET, `preset: ${id}`))
		return 'rewritten'
	}
	const afterCategory = text.replace(/\bcategory:[\s`'"*]*[\w-]+[`'"*]*;?/, (m) => `${m.endsWith(';') ? m : `${m};`} preset: ${id};`)
	writeFileSync(file, afterCategory !== text ? afterCategory : `${text.trimEnd()}\n\n**Design** — preset: ${id}\n`)
	return 'inserted'
}

/** The preset the BUILT css carries (`--preset:'<id>'`, minifier-tolerant), or undefined without a build. */
export function builtPreset(work: string): string | undefined {
	const assets = join(work, 'dist', 'assets')
	if (!existsSync(assets)) return undefined
	for (const f of readdirSync(assets).filter((n) => n.endsWith('.css'))) {
		const m = readFileSync(join(assets, f), 'utf8').match(/--preset:\s*['"]([\w-]+)['"]/)
		if (m) return m[1]
	}
	return undefined
}
