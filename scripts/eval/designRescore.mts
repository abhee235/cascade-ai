// designRescore.mts — re-score KEPT bench workdirs with the design instrument (ADR-085 P0), no model run.
//
//   npx tsx scripts/eval/designRescore.mts --out <dir> --arm "1 Luna·template=adr083-ab-control-luna6" [--arm …]
//        [--verify eval/design-review/adr083-ab] [--passes light-1440,dark-1440,light-390] [--only shop-a1]
//
// For each run in eval/runs/<label>/results.jsonl whose workdir still exists: capture it (designCapture.mts),
// score its source (designChecks.ts), and write <out>/<label>/metrics.json — the 2026-09-27 fields in their
// original shape (`source`, `trace`, `views`) plus everything new under `design`. `--verify <dir>` compares
// those 09-27 fields with the recorded run: the instrument is trusted on new runs only once it reproduces
// the old numbers (ADR-085 P0 acceptance). Summary tables: <out>/summary.md; the comparison: <out>/verify.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { neverList, parseThemeVars, rawColors, themeContract, type SourceFile } from '../../packages/server/src/designChecks'
import { projectStart, shippedTexts } from '../../packages/server/src/templates'
import { chromeDrift, hardFindings, viewStatus } from '../../packages/server/src/designMetrics'
import { captureApp, PASSES, type CaptureView, type PassName } from './designCapture.mts'

const ROOT = join(import.meta.dirname, '..', '..')
const { values: args } = parseArgs({
	options: {
		out: { type: 'string' },
		arm: { type: 'string', multiple: true },
		verify: { type: 'string' },
		passes: { type: 'string', default: Object.keys(PASSES).join(',') },
		only: { type: 'string' },
	},
})
if (!args.out || !args.arm?.length) {
	console.error('usage: designRescore.mts --out <dir> --arm "<name>=<runLabel>" [--arm …] [--verify <dir>] [--passes …] [--only <runId part>]')
	process.exit(2)
}
const arms = args.arm.map((a) => {
	const at = a.lastIndexOf('=')
	return { name: a.slice(0, at), label: a.slice(at + 1) }
})
const passes = args.passes!.split(',').map((p) => p.trim()) as PassName[]

// ── The 2026-09-27 formulas, VERBATIM from ab-measure.mjs (the proof compares like with like) ────────────
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f === 'node_modules' ? [] : walk(join(d, f))) : [join(d, f)]))
const templateCss = readFileSync(join(ROOT, 'packages/server/templates/react/src/index.css'), 'utf8')
const PALETTE = /\b(?:bg|text|border|from|to|via|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g

function legacySource(work: string) {
	const own = walk(join(work, 'src')).filter((p) => /\.(tsx?|css)$/.test(p) && !/[\\/](ui|blocks|themes)[\\/]/.test(p))
	const src = own.map((p) => readFileSync(p, 'utf8')).join('\n')
	const n = (re: RegExp) => (src.match(re) || []).length
	// A blank-start project (ADR-086) may have no src/index.css; the 09-27 fields then read as "none".
	const css = existsSync(join(work, 'src/index.css')) ? readFileSync(join(work, 'src/index.css'), 'utf8') : ''
	return {
		rawHex: n(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g),
		paletteClasses: n(PALETTE),
		arbitraryColors: n(/-\[(?:#|rgb|hsl|oklch)/g),
		cssLinesAdded: Math.max(0, css.split('\n').length - templateCss.split('\n').length),
		googleFonts: /fonts\.googleapis\.com/.test(src),
		blockImports: n(/from '@\/components\/blocks\//g),
		preset: (css.match(/@import '\.\/themes\/([^']+)\.css'/) || [])[1] ?? 'none',
		designSystemDir: existsSync(join(work, 'design-system')),
	}
}

function legacyTrace(file: string) {
	if (!existsSync(file)) return {}
	const ev = readFileSync(file, 'utf8').trim().split('\n').flatMap((l) => {
		try {
			return [JSON.parse(l)]
		} catch {
			return []
		}
	})
	const calls = ev.filter((e) => e.t === 'tool_call')
	const resp = ev.filter((e) => e.t === 'model_response')
	return {
		turns: ev.filter((e) => e.t === 'model_request').length,
		skills: calls.filter((c) => c.name === 'Skill').map((c) => c.input?.name + (c.input?.file ? `:${c.input.file}` : '')),
		uiproScriptRuns: calls.filter((c) => c.name === 'Bash' && /search\.py/.test(c.input?.command ?? '')).length,
		tokensIn: resp.reduce((a, e) => a + (e.usage?.inputTokens ?? 0), 0),
		tokensOut: resp.reduce((a, e) => a + (e.usage?.outputTokens ?? 0), 0),
	}
}

// ── The new source metrics (designChecks.ts) ────────────────────────────────────────────────────────────
function designSource(work: string) {
	const files: SourceFile[] = walk(join(work, 'src')).map((abs) => ({ path: relative(work, abs).replaceAll('\\', '/'), text: readFileSync(abs, 'utf8') }))
	// ADR-086 P1: a kit or block file the app edited counts what the edit added (the React template is open).
	const shipped = projectStart(work) === 'none' ? undefined : shippedTexts('react')
	const never: Record<string, number> = {}
	for (const f of neverList(files, { shipped })) never[f.check] = (never[f.check] ?? 0) + 1
	if (projectStart(work) === 'none') {
		// ADR-086 blank start: the theme is wherever the model DEFINED its tokens (a `:root` block of custom
		// properties). Colors there are the theme; raw colors are the ones outside it. The React contract does not
		// apply (a free theme names its own roles), so it reads n/a — dark mode is still judged by the dark pass.
		const themeFiles = files.filter((f) => f.path.endsWith('.css') && /:root\s*\{[^}]*--[\w-]+\s*:/.test(f.text)).map((f) => f.path)
		const raw = rawColors(files, { themeFiles })
		const vars = parseThemeVars(files.filter((f) => themeFiles.includes(f.path)).map((f) => f.text).join('\n'))
		const darkVia = Object.keys(vars.dark).length ? 'class' : Object.keys(vars.mediaDark).length ? 'media' : 'none'
		return { raw: { total: raw.total, byNotation: raw.byNotation }, never, theme: { file: themeFiles.join(',') || '(none)', ok: null as boolean | null, preset: 'free', missingRoot: 0, missingDark: 0, darkVia } }
	}
	const raw = rawColors(files, { shipped })
	// The theme the app ACTIVATES (src/index.css's @import), else index.css itself (free designs).
	const css = readFileSync(join(work, 'src/index.css'), 'utf8')
	const imported = css.match(/@import\s+['"]\.\/(themes\/[^'"]+\.css)['"]/)?.[1]
	const themeFile = imported && existsSync(join(work, 'src', imported)) ? `src/${imported}` : 'src/index.css'
	const t = themeContract(readFileSync(join(work, themeFile), 'utf8'))
	return { raw: { total: raw.total, byNotation: raw.byNotation }, never, theme: { file: themeFile, ok: t.ok as boolean | null, preset: t.preset, missingRoot: t.missingRoot.length, missingDark: t.missingDark.length, darkVia: t.darkVia } }
}

// ── Capture every kept run ──────────────────────────────────────────────────────────────────────────────
const LEGACY_VIEW = ['textChars', 'footers', 'headers', 'contentLeft', 'contentRight', 'h1px', 'h2px', 'pageHeight'] as const
type LegacyView = Record<(typeof LEGACY_VIEW)[number], number | null> & { arrivedScrollY: number; errors: string[] }
interface RunRecord {
	runId: string
	scenario: string
	buildOk: boolean
	solved: boolean
	timedOut: boolean
	minutes: number
	source: ReturnType<typeof legacySource>
	trace: ReturnType<typeof legacyTrace> & Record<string, any>
	/** The light 1440 px pass in the 09-27 shape — what `--verify` compares. */
	views: Record<string, LegacyView>
	design: ReturnType<typeof designSource> & { passes: Partial<Record<PassName, CaptureView[]>>; captureError?: string }
	/** The oracle seed as the bench recorded it (`--design-seed`): a run whose built preset is not the seed
	 *  drifted back and is excluded from the oracle comparison — and counted. */
	seed?: { id: string; brief: boolean; pin: string; built: string | null; kept: boolean }
}

async function launchBrowser() {
	const { chromium } = await import('playwright-core')
	for (const opts of [{}, { channel: 'msedge' }, { channel: 'chrome' }]) {
		try {
			return await chromium.launch({ headless: true, ...opts }) // 09-27 used Playwright's own Chromium
		} catch {
			/* not installed — next */
		}
	}
	throw new Error('no Chromium available (Playwright browser, Edge or Chrome)')
}

const results: Record<string, RunRecord[]> = {}
const browser = await launchBrowser()
try {
	for (const arm of arms) {
		const runDir = join(ROOT, 'eval/runs', arm.label)
		const out = join(args.out, arm.label)
		const rows = readFileSync(join(runDir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
		const records: RunRecord[] = []
		for (const row of rows) {
			const runId = String(row.traceFile).replace(/\.jsonl$/, '')
			const tag = runId.replace(/^builder-/, '')
			if (args.only && !runId.includes(args.only)) continue
			if (!row.workdir || !existsSync(join(row.workdir, 'src'))) {
				console.log(`${arm.label} ${tag}: workdir not kept — skipped`)
				continue
			}
			const t0 = Date.now()
			const cap = await captureApp({ workdir: row.workdir, scenario: row.scenario, outDir: out, tag, browser, passes })
			const light = cap.passes['light-1440'] ?? []
			const views = Object.fromEntries(
				light.map((v) => [v.name, { ...Object.fromEntries(LEGACY_VIEW.map((k) => [k, v.metrics?.[k] ?? null])), arrivedScrollY: v.arrivedScrollY, errors: v.errors } as LegacyView]),
			)
			records.push({
				runId,
				scenario: row.scenario,
				buildOk: cap.buildOk,
				solved: row.solved,
				timedOut: row.timedOut,
				minutes: Math.round(row.wallMs / 60000),
				source: legacySource(row.workdir),
				trace: legacyTrace(join(runDir, 'traces', row.traceFile)),
				views,
				design: { ...designSource(row.workdir), passes: cap.passes, ...(cap.error ? { captureError: cap.error } : {}) },
				...(row.seed ? { seed: row.seed } : {}),
			})
			const status = light.map((v) => `${v.name}:${viewStatus(v)}`).join(' ')
			console.log(`${arm.label} ${tag}: build ${cap.buildOk ? 'ok' : 'FAIL'} · ${status}${cap.error ? ` · ERROR ${cap.error}` : ''} (${Math.round((Date.now() - t0) / 1000)}s)`)
		}
		mkdirSync(out, { recursive: true })
		writeFileSync(join(out, 'metrics.json'), JSON.stringify(records, null, 2))
		results[arm.label] = records
	}
} finally {
	await browser.close()
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────────────
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const avg = (xs: number[]) => (xs.length ? (sum(xs) / xs.length).toFixed(1) : '–')
const SCENARIOS = ['builder-shop', 'builder-landing']
// By the recorded scenario, not the run id: a single-attempt run's id has no `-aN` suffix (the ADR-086 image probe
// was dropped), and `builder-shop-` also prefixes `builder-shop-iterate-…`.
const inScenario = (rs: RunRecord[], s: string) => rs.filter((r) => r.scenario === s)

/** ab-summary.mjs's row, VERBATIM — the table the 09-27 summary.md was rendered from. */
function legacyRow(name: string, rs: RunRecord[]): Record<string, string | number> {
	const cost = `$${sum(rs.map((r) => ((r.trace.tokensIn ?? 0) * 0.1 + (r.trace.tokensOut ?? 0) * 0.5) / 1e6)).toFixed(2)}`
	const views = rs.map((r) => Object.values(r.views ?? {}).filter((v) => v && typeof v === 'object'))
	const widths = views.map((vs) => vs.map((v) => (v.contentRight ?? 0) - (v.contentLeft ?? 0)).filter((w) => w > 0))
	return {
		arm: name,
		builds: `${rs.filter((r) => r.buildOk).length}/${rs.length}`,
		'crashed views': sum(views.map((vs) => vs.filter((v) => (v.errors ?? []).length > 0).length)),
		'bench check*': `${rs.filter((r) => r.solved).length}/${rs.length}`,
		'avg min': avg(rs.map((r) => r.minutes)),
		'avg turns': avg(rs.map((r) => r.trace.turns ?? 0)),
		'cost ≤': cost,
		'skill loaded': `${rs.filter((r) => (r.trace.skills ?? []).some((s: string) => s.startsWith('ui-ux-pro-max'))).length}/${rs.length}`,
		'script runs': sum(rs.map((r) => r.trace.uiproScriptRuns ?? 0)),
		'design-system/': rs.filter((r) => r.source.designSystemDir).length,
		'raw hex': sum(rs.map((r) => r.source.rawHex)),
		'palette cls': sum(rs.map((r) => r.source.paletteClasses)),
		'css +lines': sum(rs.map((r) => r.source.cssLinesAdded)),
		'google fonts': rs.filter((r) => r.source.googleFonts).length,
		'block imports': avg(rs.map((r) => r.source.blockImports)),
		presets: [...new Set(rs.map((r) => r.source.preset))].join(','),
		'footer on all views': views.filter((vs) => vs.length && vs.every((v) => (v.footers ?? 0) > 0)).length + `/${rs.length}`,
		'width jump px (avg)': avg(widths.map((ws) => (ws.length > 1 ? Math.max(...ws) - Math.min(...ws) : 0))),
		'blank views': sum(views.map((vs) => vs.filter((v) => (v.textChars ?? 0) < 40).length)),
	}
}

/** The new instrument's view of the same runs. Footer and drift count REACHED views only. */
function designRow(name: string, rs: RunRecord[]): Record<string, string | number> {
	const reachedOf = (r: RunRecord, p: PassName) => (r.design.passes[p] ?? []).filter((v) => v.reached)
	const light = rs.map((r) => reachedOf(r, 'light-1440'))
	const all = rs.flatMap((r) => r.design.passes['light-1440'] ?? [])
	const flat = light.flat()
	const m390 = rs.flatMap((r) => reachedOf(r, 'light-390'))
	const dark = rs.flatMap((r) => reachedOf(r, 'dark-1440').map((v) => (r.design.passes['light-1440'] ?? []).find((l) => l.name === v.name)?.pageBg !== v.pageBg))
	const drifts = light.map((vs) => chromeDrift(vs.map((v) => v.metrics!))).filter((d): d is number => d !== null)
	// ADR-086 P1: per app, its WORST view's gap ratio; the brand mark as its first view shows it.
	const gapRatios = light.map((vs) => vs.map((v) => v.metrics?.rhythm?.ratio).filter((x): x is number => typeof x === 'number')).filter((xs) => xs.length).map((xs) => Math.max(...xs))
	const logos = light.map((vs) => vs.find((v) => v.metrics?.logo)?.metrics?.logo).filter((l): l is NonNullable<typeof l> => !!l)
	const kinds: Record<string, number> = {}
	for (const l of logos) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1
	const never: Record<string, number> = {}
	for (const r of rs) for (const [k, n] of Object.entries(r.design.never)) never[k] = (never[k] ?? 0) + n
	const notations: Record<string, number> = {}
	for (const r of rs) for (const [k, n] of Object.entries(r.design.raw.byNotation)) notations[k] = (notations[k] ?? 0) + (n ?? 0)
	return {
		arm: name,
		'views reached': `${flat.length}/${all.length}`,
		'HARD-failing views': flat.filter((v) => hardFindings(v).length).length,
		crashed: flat.filter((v) => v.errors.length).length,
		blank: flat.filter((v) => v.metrics?.blank).length,
		'broken img': sum(flat.map((v) => v.metrics?.images.broken ?? 0)),
		'invisible CTA': sum(flat.map((v) => v.metrics?.contrast.invisibleInteractive ?? 0)),
		'site footer on all views': `${light.filter((vs) => vs.length && vs.every((v) => v.metrics?.chrome.footer)).length}/${rs.length}`,
		'chrome drift px (avg)': avg(drifts),
		'gap max/min (avg · worst)': gapRatios.length ? `${avg(gapRatios)} · ${Math.max(...gapRatios).toFixed(1)}` : '–',
		'logo (kinds · avg px)': logos.length ? `${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')} · ${avg(logos.map((l) => l.height))}` : '–',
		'raw colors / app': avg(rs.map((r) => r.design.raw.total)),
		notations: Object.entries(notations).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '–',
		'never-list': Object.entries(never).map(([k, n]) => `${k} ${n}`).join(', ') || '–',
		'contrast fails / view': avg(flat.map((v) => v.metrics?.contrast.fail ?? 0)),
		'overflow @390': `${m390.filter((v) => (v.metrics?.overflow.count ?? 0) > 0).length}/${m390.length}`,
		'dark went dark': `${dark.filter(Boolean).length}/${dark.length}`,
		'theme contract': rs.every((r) => r.design.theme.ok === null) ? 'n/a (free theme)' : `${rs.filter((r) => r.design.theme.ok).length}/${rs.length}`,
		'seed kept': rs.some((r) => r.seed) ? `${rs.filter((r) => r.seed?.kept).length}/${rs.filter((r) => r.seed).length}` : '–',
	}
}

const table = (rows: Record<string, string | number>[]) => {
	const cols = Object.keys(rows[0]!)
	return [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map((t) => `| ${cols.map((c) => t[c]).join(' | ')} |`)].join('\n')
}
const legacyTables: Record<string, string[]> = {}
let md = `# Design rescore — ${arms.map((a) => a.label).join(', ')}\n\nPasses: ${passes.join(', ')}. Legacy table = the 2026-09-27 columns, recomputed; design table = the ADR-085 instrument.\n`
for (const s of SCENARIOS) {
	const present = arms.filter((a) => inScenario(results[a.label] ?? [], s).length)
	if (!present.length) continue
	const legacy = table(present.map((a) => legacyRow(a.name, inScenario(results[a.label]!, s))))
	legacyTables[s] = legacy.split('\n').slice(2)
	md += `\n## ${s}\n\n### Legacy (09-27 columns)\n\n${legacy}\n\n### Design instrument\n\n${table(present.map((a) => designRow(a.name, inScenario(results[a.label]!, s))))}\n\n### Views (light 1440: pass / FAIL / unreachable)\n\n`
	for (const a of present) {
		for (const r of inScenario(results[a.label]!, s)) {
			const vs = (r.design.passes['light-1440'] ?? []).map((v) => `${v.name} ${viewStatus(v) === 'fail' ? `FAIL (${hardFindings(v).join('; ')})` : viewStatus(v)}`)
			md += `- ${a.name} ${r.runId.replace(/^builder-/, '')}: ${vs.join(', ') || r.design.captureError || 'no views'}\n`
		}
	}
}
mkdirSync(args.out, { recursive: true })
writeFileSync(join(args.out, 'summary.md'), md)
console.log(`\nwrote ${join(args.out, 'summary.md')}`)

// ── --verify: does the instrument reproduce the recorded run? Field by field, then cell by cell. ─────────
if (args.verify) {
	const SOURCE = ['rawHex', 'paletteClasses', 'arbitraryColors', 'cssLinesAdded', 'googleFonts', 'blockImports', 'preset', 'designSystemDir'] as const
	const mismatches: { where: string; field: string; old: unknown; now: unknown }[] = []
	let compared = 0
	const check = (where: string, field: string, old: unknown, now: unknown) => {
		compared++
		if (JSON.stringify(old) !== JSON.stringify(now)) mismatches.push({ where, field, old, now })
	}
	for (const arm of arms) {
		const file = join(args.verify, arm.label, 'metrics.json')
		if (!existsSync(file)) continue
		const recorded = (JSON.parse(readFileSync(file, 'utf8')) as any[]).filter((r) => !r.skipped)
		for (const now of results[arm.label] ?? []) {
			const old = recorded.find((r) => r.runId === now.runId)
			if (!old) continue
			const where = `${arm.label.replace(/^adr083-ab-/, '')} ${now.runId.replace(/^builder-/, '')}`
			check(where, 'buildOk', old.buildOk, now.buildOk)
			for (const f of SOURCE) check(where, `source.${f}`, old.source?.[f], now.source[f])
			for (const v of new Set([...Object.keys(old.views ?? {}), ...Object.keys(now.views)])) {
				for (const f of LEGACY_VIEW) check(where, `${v}.${f}`, old.views?.[v]?.[f], now.views[v]?.[f])
				check(where, `${v}.errors`, (old.views?.[v]?.errors ?? []).length, (now.views[v]?.errors ?? []).length)
			}
		}
	}
	// The recorded summary.md, row by row (rows are keyed by arm name within each scenario section).
	const summaryFile = join(args.verify, 'summary.md')
	let cells = 0
	const cellDiffs: string[] = []
	if (existsSync(summaryFile)) {
		const sections = readFileSync(summaryFile, 'utf8').split(/^## /m)
		for (const [s, rows] of Object.entries(legacyTables)) {
			const section = sections.find((x) => x.startsWith(s))
			if (!section) continue
			const header = section.split('\n').find((l) => l.startsWith('| arm |'))!.split('|').slice(1, -1).map((c) => c.trim())
			for (const row of rows) {
				const nowCells = row.split('|').slice(1, -1).map((c) => c.trim())
				const oldRow = section.split('\n').find((l) => l.startsWith(`| ${nowCells[0]} |`))
				if (!oldRow) continue
				const oldCells = oldRow.split('|').slice(1, -1).map((c) => c.trim())
				nowCells.forEach((c, i) => {
					cells++
					if (c !== oldCells[i]) cellDiffs.push(`${s} · ${nowCells[0]} · ${header[i]}: ${oldCells[i]} → ${c}`)
				})
			}
		}
	}
	const byField = new Map<string, typeof mismatches>()
	for (const m of mismatches) byField.set(m.field.replace(/^\d-[a-z]+\./, 'view.'), [...(byField.get(m.field.replace(/^\d-[a-z]+\./, 'view.')) ?? []), m])
	let v = `# Rescore vs the recorded run (${args.verify})\n\n`
	v += `- Run fields: **${compared - mismatches.length}/${compared}** identical\n- Summary cells: **${cells - cellDiffs.length}/${cells}** identical\n`
	if (mismatches.length) {
		v += `\n## Field mismatches (${mismatches.length})\n\n`
		for (const [field, ms] of byField) v += `### ${field} (${ms.length})\n\n${ms.map((m) => `- ${m.where} ${m.field}: ${JSON.stringify(m.old)} → ${JSON.stringify(m.now)}`).join('\n')}\n\n`
	}
	if (cellDiffs.length) v += `\n## Summary cell differences (${cellDiffs.length})\n\n${cellDiffs.map((d) => `- ${d}`).join('\n')}\n`
	writeFileSync(join(args.out, 'verify.md'), v)
	console.log(v.split('\n').slice(0, 4).join('\n'))
	console.log(`wrote ${join(args.out, 'verify.md')}`)
	if (mismatches.length || cellDiffs.length) process.exitCode = 1
}
