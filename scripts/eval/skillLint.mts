// scripts/eval/skillLint.mts — grade skill/agent files against the OFFICIAL authoring checklist
// (the published skill-authoring best practices + checklist/success-criteria rules). The no-GPU quality loop:
// mechanical checks on every save; behavioral truth still comes from traces.
//
//   npx tsx scripts/eval/skillLint.mts [dir ...]     (default: the server's builder skills + agents)
//
// FAIL = violates a hard rule (exit 1). WARN = judged against best practice (exit 0) — fix or justify.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface Finding {
	level: 'FAIL' | 'WARN'
	file: string
	rule: string
	detail: string
}

interface Doc {
	file: string
	kind: 'skill' | 'agent'
	meta: Record<string, string>
	body: string
	references: string[] // bundled reference docs (dir skills)
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
	if (!m) return { meta: {}, body: raw.trim() }
	const meta: Record<string, string> = {}
	for (const line of m[1]!.split('\n')) {
		const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
		if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim()
	}
	return { meta, body: raw.slice(m[0].length).trim() }
}

const KNOWN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'Bash', 'TodoWrite', 'Lsp', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Memory', 'MemorySearch', 'Subagent', 'Skill'])

export function lintDoc(doc: Doc): Finding[] {
	const f: Finding[] = []
	const add = (level: Finding['level'], rule: string, detail: string) => f.push({ level, file: doc.file, rule, detail })
	const { meta, body } = doc
	const name = meta.name ?? ''
	const desc = meta.description ?? ''
	const when = meta.whentouse ?? meta.when_to_use ?? ''

	// ── Hard rules (official frontmatter requirements) ──
	if (!name) add('FAIL', 'name-required', 'frontmatter has no name')
	else {
		if (name.length > 64) add('FAIL', 'name-length', `${name.length} chars (max 64)`)
		if (!/^[a-z0-9-]+$/.test(name)) add('WARN', 'name-format', `"${name}" — official rule: lowercase letters, numbers, hyphens only`)
		if (/anthropic|claude/i.test(name)) add('FAIL', 'name-reserved', `"${name}" uses a reserved word`)
	}
	if (!desc) add('FAIL', 'description-required', 'frontmatter has no description')
	else {
		if (desc.length > 1024) add('FAIL', 'description-length', `${desc.length} chars (max 1024)`)
		if (desc.length < 40) add('WARN', 'description-vague', `only ${desc.length} chars — descriptions are ROUTERS: say what it does AND when, with the words a user would say`)
		if (/^(I |You can|We )/i.test(desc)) add('WARN', 'description-pov', 'write in third person ("Processes X…", not "I/You…") — POV inconsistency hurts discovery')
	}
	if (doc.kind === 'skill' && !when && !/use when/i.test(desc)) {
		add('WARN', 'trigger-language', 'no whenToUse and no "Use when…" in the description — the model has no routing triggers')
	}

	// ── Body rules ──
	const lines = body.split('\n')
	if (lines.length > 500) add('FAIL', 'body-length', `${lines.length} lines (official cap 500) — split into reference files`)
	else if (lines.length > 300) add('WARN', 'body-length', `${lines.length} lines — consider splitting toward references before hitting the 500 cap`)
	if (body.length === 0) add('FAIL', 'body-empty', 'no body content')
	if (/[A-Za-z]:\\|(?<!\\)\\(?:src|scripts|reference|docs)\b/.test(body)) add('WARN', 'windows-paths', 'backslash path in body — always use forward slashes (official anti-pattern)')
	if (/\b(before|after|until)\s+(19|20)\d{2}\b/i.test(body)) add('WARN', 'time-sensitive', 'date-conditional instruction — will silently rot; use an "old patterns" section instead')

	// Multi-step workflow without a copyable checklist (skillify: checklists + success criteria per step).
	const numberedSteps = (body.match(/^\s*\d+\.\s/gm) ?? []).length
	if (doc.kind === 'skill' && numberedSteps >= 4 && !body.includes('- [ ]')) {
		add('WARN', 'no-checklist', `${numberedSteps} numbered steps but no copyable "- [ ]" checklist (skillify rule: checklist + success criteria)`)
	}

	// Bundled references must be advertised in the body ("ignored content" smell otherwise).
	for (const ref of doc.references) {
		if (!body.includes(ref)) add('WARN', 'unadvertised-reference', `bundled ${ref} is never mentioned in the body — the model will not know to load it`)
	}

	// ── Agent-specific ──
	if (doc.kind === 'agent') {
		for (const t of (meta.tools ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
			if (!KNOWN_TOOLS.has(t)) add('FAIL', 'unknown-tool', `tools lists "${t}" — not a Cascade tool (typo disables the agent's allowlist)`)
		}
		if (meta.maxturns && !/^\d+$/.test(meta.maxturns)) add('FAIL', 'maxturns-numeric', `maxTurns "${meta.maxturns}" is not a number`)
		if (!body.includes('- [ ]') && !/success criteria/i.test(body)) add('WARN', 'no-success-criteria', 'agent body has no self-check/success criteria — skillify requires knowing what done looks like')
	}
	return f
}

export function collectDocs(dir: string, kind: 'skill' | 'agent'): Doc[] {
	const docs: Doc[] = []
	if (!existsSync(dir)) return docs
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'index.md') {
			const { meta, body } = parseFrontmatter(readFileSync(join(dir, e.name), 'utf8'))
			docs.push({ file: join(dir, e.name), kind, meta, body, references: [] })
		} else if (e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md'))) {
			const { meta, body } = parseFrontmatter(readFileSync(join(dir, e.name, 'SKILL.md'), 'utf8'))
			const references: string[] = []
			const walk = (sub: string, rel: string) => {
				for (const s of readdirSync(sub, { withFileTypes: true })) {
					if (s.isDirectory()) walk(join(sub, s.name), `${rel}${s.name}/`)
					else if (s.name.endsWith('.md') && s.name !== 'SKILL.md') references.push(`${rel}${s.name}`)
				}
			}
			walk(join(dir, e.name), '')
			docs.push({ file: join(dir, e.name, 'SKILL.md'), kind, meta, body, references })
		}
	}
	return docs
}

// ── CLI ──
const isMain = process.argv[1] && statSync(process.argv[1]).isFile() && basename(process.argv[1]).startsWith('skillLint')
if (isMain) {
	const ROOT = join(import.meta.dirname, '..', '..')
	const args = process.argv.slice(2)
	const targets: { dir: string; kind: 'skill' | 'agent' }[] = args.length
		? args.map((d) => ({ dir: d, kind: d.includes('agent') ? 'agent' as const : 'skill' as const }))
		: [
				{ dir: join(ROOT, 'packages', 'server', 'skills', 'builder'), kind: 'skill' as const },
				{ dir: join(ROOT, 'packages', 'server', 'agents', 'builder'), kind: 'agent' as const },
			]
	let fails = 0
	let warns = 0
	let count = 0
	for (const t of targets) {
		for (const doc of collectDocs(t.dir, t.kind)) {
			count++
			const findings = lintDoc(doc)
			const rel = doc.file.slice(ROOT.length + 1)
			if (findings.length === 0) console.log(`✓ ${rel}`)
			for (const x of findings) {
				if (x.level === 'FAIL') fails++
				else warns++
				console.log(`${x.level === 'FAIL' ? '✗' : '⚠'} ${rel} [${x.rule}] ${x.detail}`)
			}
		}
	}
	console.log(`\n${count} files · ${fails} fails · ${warns} warnings`)
	process.exit(fails > 0 ? 1 : 0)
}
