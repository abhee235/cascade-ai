// auditTool.ts — the TemplateAudit tool (design-overhaul P1): scan a generated app for TEMPLATE RESIDUE
// before it may be called done. Measured motivation: two consecutive builder-shop runs shipped the demo
// shell ("Meridian" brand, demo imports in App.tsx) behind a green build — the prose rule "delete the
// demo" (AI_RULES.md) demonstrably doesn't hold a weak model; this is the same class ADR-049 fixed for
// verification, solved the same way: structurally.
//
// Shape follows packTool.ts: injected deps, a factory returning `Tool | undefined` (self-gating — no
// residue contract ⇒ the tool never exists), findings returned as text the model acts on. HARD findings
// block "done" (the core audit gate + the done-ladder enforce running this tool; its OUTPUT semantics
// stay server-side — core only tracks that it ran). SOFT findings are fix-or-override-with-a-reason.
// Read-only: it never edits the project; the model does the fixing.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { Tool } from '@cascade/core'
import { readResidueContract, shippedTexts, type ResidueFinding } from './templates.js'

const inputSchema = z.object({})

/** Directories never scanned — bulk, and node_modules legitimately contains anything. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.cascade'])

/** Source-ish files worth scanning for string needles. */
const SCAN_EXT = /\.(tsx?|jsx?|css|html|json|md)$/

interface Hit {
	finding: ResidueFinding
	where: string // "src/App.tsx:11" or a path
}

function* walk(dir: string, root: string): Generator<string> {
	let entries: import('node:fs').Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (!SKIP.has(e.name)) yield* walk(join(dir, e.name), root)
		} else if (SCAN_EXT.test(e.name)) {
			yield join(dir, e.name)
		}
	}
}

function scan(projectDir: string, findings: ResidueFinding[]): Hit[] {
	const hits: Hit[] = []
	// Cache file contents per scope so N needles over one scope read each file once.
	const filesOf = new Map<string, { path: string; lines: string[] }[]>()
	const loadScope = (scope: string) => {
		if (!filesOf.has(scope)) {
			const abs = join(projectDir, scope)
			const list: { path: string; lines: string[] }[] = []
			for (const f of walk(abs, abs)) {
				try {
					list.push({ path: relative(projectDir, f).replaceAll('\\', '/'), lines: readFileSync(f, 'utf8').split('\n') })
				} catch {
					/* unreadable file — skip */
				}
			}
			filesOf.set(scope, list)
		}
		return filesOf.get(scope)!
	}

	/** Corroboration for an ordinary-English needle: does the project carry HARDER demo evidence? A path
	 *  that exists, or an import prefix that appears anywhere in src. See ResidueFinding.requires. */
	const corroborated = (requires: string[]): boolean =>
		requires.some((r) => (r.startsWith('@/') ? loadScope('src').some((f) => f.lines.some((l) => l.includes(r))) : existsSync(join(projectDir, r))))

	for (const finding of findings) {
		if (finding.requires?.length && !corroborated(finding.requires)) continue
		if (finding.kind === 'path' && finding.path) {
			if (existsSync(join(projectDir, finding.path))) hits.push({ finding, where: finding.path })
		} else if (finding.kind === 'string' && finding.needle) {
			for (const file of loadScope(finding.scope ?? 'src')) {
				const line = file.lines.findIndex((l) => l.includes(finding.needle!))
				if (line >= 0) {
					hits.push({ finding, where: `${file.path}:${line + 1}` })
					break // one location per finding is enough to act on
				}
			}
		} else if (finding.kind === 'file' && finding.path && finding.mustNotContain) {
			try {
				const text = readFileSync(join(projectDir, finding.path), 'utf8')
				const line = text.split('\n').findIndex((l) => l.includes(finding.mustNotContain!))
				if (line >= 0) hits.push({ finding, where: `${finding.path}:${line + 1}` })
			} catch {
				/* file absent — nothing to flag */
			}
		}
	}
	return hits
}

/** Built-in SOFT style pre-flights — source-side twins of eval designLint, so the model hears about a
 *  style landmine BEFORE the bench (or the user) does. Template-generic by construction (tokens/blocks
 *  are the house system), so they live here rather than in the per-template contract. */
/** How many raw-color line numbers to name before summarising the rest — enough to fix in one pass
 *  without turning a wholesale-untokenized file into a wall of numbers. */
const RAW_COLOR_LINES_SHOWN = 8

function styleSoftHits(projectDir: string, templateId: string): Hit[] {
	const hits: Hit[] = []
	const src = join(projectDir, 'src')
	const raw = /\b(?:bg|text|border|from|to|ring)-(?:white|black|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/
	const shipped = shippedTexts(templateId)
	for (const f of walk(src, src)) {
		if (!/\.tsx?$/.test(f)) continue
		const rel = relative(projectDir, f).replaceAll('\\', '/')
		let text: string
		try {
			text = readFileSync(f, 'utf8')
		} catch {
			continue
		}
		// ADR-086 P1 retired the frozen-layer HARD check: blocks are patterns the app may adapt, and the kit is
		// editable as shadcn intends. What an edit ADDS is still judged: a raw-color line the shipped version of
		// this file already carries is template code, not the model's styling (review, 2026-10-04: an edited kit
		// file reported every line, the template's too). An untouched file therefore reports nothing.
		const theirs = new Set((shipped(rel) ?? []).flatMap((t) => t.split('\n')).filter((l) => raw.test(l)).map((l) => l.trim()))
		const lines = text.split('\n')
		// EVERY raw-color line, not just the first. Measured (qwen36-agentic-iq4, builder-shop 2026-08-11):
		// reporting one occurrence per file turned a two-instance file into a whack-a-mole — audit, fix :66,
		// audit, fix :113 — three wasted turns for one class of defect. All the lines at once means one edit.
		const rawLines = lines.flatMap((l, i) => (raw.test(l) && !theirs.has(l.trim()) ? [i + 1] : []))
		if (rawLines.length > 0) {
			const shown = rawLines.slice(0, RAW_COLOR_LINES_SHOWN)
			const more = rawLines.length - shown.length
			hits.push({
				finding: {
					kind: 'string',
					why: `raw color utility on ${rawLines.length === 1 ? 'this line' : `${rawLines.length} lines (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`} — the design system is token-only (bg-primary, text-muted-foreground, …)`,
					fix: 'Replace EVERY one with the token utility in a single pass (design skill §4 has the substitution table).',
				},
				where: `${rel}:${rawLines[0]}`,
			})
		}
		// A REIMPLEMENTED HOUSE HELPER. Measured (qwen3.5:9b, builder-landing 2026-08-15): the model wrote its
		// OWN `function photo(name: string)` returning `/photos/<name>.webp` — paths that do not exist — and
		// never imported @/lib/photos. Every downstream signal said fine: its local helper takes `string`, so
		// tsc passed; the real module went unused, so no photo was bundled; the page shipped a broken <img>.
		//
		// This is the blocks failure in a directory that CANNOT be frozen — src/lib is the model's own space,
		// and it must stay writable. So it is caught by name: a local definition that shadows a helper the
		// template already provides is always a mistake, because the real one resolves bundled assets that a
		// hand-written string never will.
		// …except in the module that legitimately DEFINES them. (Caught by running this against the real
		// failing project: it flagged src/lib/photos.ts three times for doing its job.)
		for (const helper of rel === 'src/lib/photos.ts' ? [] : ['photo', 'photoFor', 'webPhoto']) {
			const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${helper}\\s*\\(|^\\s*(?:export\\s+)?const\\s+${helper}\\s*(?::[^=]+)?=\\s*(?:\\(|async)`).test(l))
			if (at >= 0) {
				hits.push({
					finding: {
						kind: 'string',
						why: `re-defines \`${helper}()\`, which the template already provides — a hand-written image path resolves to nothing, so the page ships a broken image while the build stays green`,
						fix: `Delete this function and \`import { ${helper} } from '@/lib/photos'\`. Its argument is a FIXED set of bundled photo names (see the design skill's IMAGERY section) — an invented name returns an empty src.`,
					},
					where: `${rel}:${at + 1}`,
				})
			}
		}
		// A HERO WITH NO PICTURE. Measured (qwen3.5:9b, builder-landing 2026-08-15): the model composed nine
		// blocks into a real landing page and passed `media` to none of them, shipping a page with no image
		// anywhere — the flat-page failure the design skill names, and the only thing its run still failed on.
		//
		// Keyed off the BLOCK the file actually renders, not the kind of app: a dashboard never mounts a Hero,
		// so it is never asked for a photograph it has no use for. (The same reason eval's designLint made
		// imagery opt-out rather than universal — a check that fails correct work teaches models to bolt on
		// decoration.) `media` is Hero's own prop name, so this cannot fire on a hero that HAS one.
		const heroAt = lines.findIndex((l) => /<Hero[\s/>]/.test(l))
		if (heroAt >= 0 && !/\bmedia=/.test(text)) {
			hits.push({
				finding: {
					kind: 'string',
					why: 'a <Hero> with no `media` — the page has no image at all, which is what makes a landing page read as unfinished',
					fix: 'Pass media: `<Hero media={<img src={photo("workspace-code")} alt="…" />} …/>` for a bundled photo, or `<Photo web="<subject>" seed="hero" />` for a real subject-specific one (design skill: IMAGERY).',
				},
				where: `${rel}:${heroAt + 1}`,
			})
		}
		// photoFor inside a .map() render — the "all my products look like the same watch" bug: flag a
		// photoFor call on the same line as .map( or within the 6 lines after one (the callback body).
		const photoForInMap = lines.findIndex((l, i) => /photoFor\(/.test(l) && lines.slice(Math.max(0, i - 6), i + 1).some((p) => /\.map\(/.test(p)))
		if (photoForInMap >= 0) {
			hits.push({ finding: { kind: 'string', why: 'photoFor inside a list render — the ~2-per-category pack repeats visibly on grids', fix: 'Use <Photo web="<subject>" seed={item.id}> per item (design skill IMAGERY ROUTING).' }, where: `${rel}:${photoForInMap + 1}` })
		}
	}
	return hits
}

export interface AuditToolDeps {
	projectDir: string
	templateId: string
}

/** Build the per-session TemplateAudit tool, or undefined when the template ships no residue contract. */
export function createTemplateAuditTool(deps: AuditToolDeps): Tool | undefined {
	const contract = readResidueContract(deps.templateId)
	if (!contract || (contract.hard.length === 0 && contract.soft.length === 0)) return undefined

	const tool: Tool<z.infer<typeof inputSchema>> = {
		name: 'TemplateAudit',
		description:
			'Scan the project for TEMPLATE RESIDUE — demo content, unreplaced placeholders, an entry point still wired to the scaffold. Run it before declaring the app done: HARD findings BLOCK done (fix every one, then re-run until clean); SOFT findings should be fixed or overridden with a stated reason. No input needed.',
		inputSchema,
		activitySummary: () => 'Auditing for template residue',
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		// The gate contract rides the TOOL, not a session option (the reviewed alternative — one core
		// name-knob per gated tool — does not scale): registering this tool is what arms the loop's
		// run-before-done gate; no other wiring exists.
		mustRunBeforeDone: true,

		async call() {
			try {
				const hard = scan(deps.projectDir, contract.hard)
				const soft = [...scan(deps.projectDir, contract.soft), ...styleSoftHits(deps.projectDir, deps.templateId)]
				if (hard.length === 0 && soft.length === 0) {
					return { content: 'TemplateAudit clean — no template residue. The scaffold has been fully replaced by the app.' }
				}
				const lines: string[] = []
				if (hard.length) {
					lines.push(`HARD residue (${hard.length}) — the app is NOT done until every one is fixed:`)
					for (const h of hard) lines.push(`- ${h.where} — ${h.finding.why}. FIX: ${h.finding.fix}`)
				}
				if (soft.length) {
					lines.push(`SOFT findings (${soft.length}) — fix, or override with a one-line reason:`)
					for (const s of soft) lines.push(`- ${s.where} — ${s.finding.why}. FIX: ${s.finding.fix}`)
				}
				lines.push(hard.length ? 'Fix the HARD findings, then call TemplateAudit again.' : 'No HARD residue — address the SOFT findings or state why not.')
				return { content: lines.join('\n'), isError: hard.length > 0 }
			} catch (e) {
				return { content: `TemplateAudit failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
			}
		},
	}
	return tool as Tool
}
