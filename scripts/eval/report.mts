// scripts/eval/report.mts — the eval analyzer (PLAN-eval E4).
//
//   npx tsx scripts/eval/report.mts <run-label>              → scoreboard + failure classes (writes scoreboard.md)
//   npx tsx scripts/eval/report.mts --diff <runA> <runB>     → per-task regressions/improvements + metric deltas
//
// Reads eval/runs/<label>/{results.jsonl, traces/} and classifies every failed trial via classify.mts —
// the output tells you WHICH harness subsystem to tweak (the PLAN-eval routing table), not just the score.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, parseTrace, type Classification } from './classify.mts'

const ROOT = join(import.meta.dirname, '..', '..')
const runDir = (label: string) => (existsSync(label) ? label : join(ROOT, 'eval', 'runs', label))

interface Row {
	task: string
	trial: number
	solved: boolean
	timedOut: boolean
	wallMs: number
	turns: number
	toolCalls: number
	toolErrors: number
	inputTokens: number
	outputTokens: number
	usageReported: boolean
	compactions: { kind: string }[]
	[k: string]: unknown
}

function loadRun(label: string): { dir: string; rows: Row[] } {
	const dir = runDir(label)
	const resultsPath = join(dir, 'results.jsonl')
	if (!existsSync(resultsPath)) {
		console.error(`no results at ${resultsPath}`)
		process.exit(2)
	}
	const rows = readFileSync(resultsPath, 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Row)
	return { dir, rows }
}

function classifyRow(dir: string, row: Row): Classification {
	// Rows carry traceFile since the backend-crash-retry change (a retry gets `-r1`); fall back for old runs.
	const tracePath = join(dir, 'traces', (row.traceFile as string) ?? `${row.task}-t${row.trial}.jsonl`)
	const events = existsSync(tracePath) ? parseTrace(readFileSync(tracePath, 'utf8')) : []
	// maxTurns comes from the task spec; fall back to the observed turn count (classifier only compares ≥).
	const taskSpec = join(ROOT, 'eval', 'tasks', row.task, 'task.json')
	const maxTurns = existsSync(taskSpec) ? (JSON.parse(readFileSync(taskSpec, 'utf8')).budgets?.maxTurns ?? Infinity) : Infinity
	return classify(events, { solved: row.solved, timedOut: row.timedOut, turns: row.turns, maxTurns })
}

const fmtTok = (r: Row) => (r.usageReported ? `${((r.inputTokens + r.outputTokens) / 1000).toFixed(1)}k` : '—')

// ── report mode ──────────────────────────────────────────────────────────────────────────────────────────
function report(label: string): void {
	const { dir, rows } = loadRun(label)
	const classified = rows.map((r) => ({ row: r, cls: classifyRow(dir, r) }))

	const table = classified.map(({ row, cls }) => ({
		task: row.task,
		trial: row.trial,
		solved: row.solved ? '✅' : '❌',
		class: cls.class === 'solved' ? '' : cls.class,
		evidence: cls.class === 'solved' ? '' : cls.evidence,
		s: Math.round(row.wallMs / 1000),
		turns: row.turns,
		'tools(err)': `${row.toolCalls}(${row.toolErrors})`,
		tok: fmtTok(row),
		compact: row.compactions.length,
	}))
	console.table(table)

	const solved = rows.filter((r) => r.solved).length
	const byClass = new Map<string, number>()
	for (const { cls } of classified) if (cls.class !== 'solved') byClass.set(cls.class, (byClass.get(cls.class) ?? 0) + 1)
	console.log(`\n${solved}/${rows.length} solved`)
	if (byClass.size) {
		console.log('failures by class (→ the knob to tweak, per docs/PLAN-eval.md):')
		for (const [c, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${c}`)
	}

	// scoreboard.md — the committed-artifact form (run dirs are gitignored; copy into docs when baselining).
	const md = [
		`# Eval scoreboard — ${label}`,
		'',
		`**${solved}/${rows.length} solved**`,
		'',
		'| task | trial | solved | class | s | turns | tools(err) | tokens | compactions |',
		'|---|---|---|---|---|---|---|---|---|',
		...table.map((t) => `| ${t.task} | ${t.trial} | ${t.solved} | ${t.class} | ${t.s} | ${t.turns} | ${t['tools(err)']} | ${t.tok} | ${t.compact} |`),
	].join('\n')
	writeFileSync(join(dir, 'scoreboard.md'), `${md}\n`)
	console.log(`\nscoreboard → ${join(dir, 'scoreboard.md')}`)
}

// ── diff mode ────────────────────────────────────────────────────────────────────────────────────────────
function diff(labelA: string, labelB: string): void {
	const a = loadRun(labelA)
	const b = loadRun(labelB)
	// Compare trial 1 per task (the stable comparison unit; N-trial aggregation can come later).
	const byTask = (rows: Row[]) => new Map(rows.filter((r) => r.trial === 1).map((r) => [r.task, r]))
	const A = byTask(a.rows)
	const B = byTask(b.rows)
	const tasks = [...new Set([...A.keys(), ...B.keys()])].sort()

	const rows = tasks.map((task) => {
		const ra = A.get(task)
		const rb = B.get(task)
		const flip = ra && rb ? (ra.solved === rb.solved ? '' : rb.solved ? '⬆ FIXED' : '⬇ REGRESSED') : '(missing)'
		return {
			task,
			[labelA]: ra ? (ra.solved ? '✅' : '❌') : '—',
			[labelB]: rb ? (rb.solved ? '✅' : '❌') : '—',
			change: flip,
			'Δturns': ra && rb ? rb.turns - ra.turns : '—',
			'Δtok': ra && rb && ra.usageReported && rb.usageReported ? `${(((rb.inputTokens + rb.outputTokens) - (ra.inputTokens + ra.outputTokens)) / 1000).toFixed(1)}k` : '—',
			'Δs': ra && rb ? Math.round((rb.wallMs - ra.wallMs) / 1000) : '—',
		}
	})
	console.table(rows)

	const solvedA = a.rows.filter((r) => r.trial === 1 && r.solved).length
	const solvedB = b.rows.filter((r) => r.trial === 1 && r.solved).length
	const regressions = rows.filter((r) => r.change === '⬇ REGRESSED').length
	console.log(`\n${labelA}: ${solvedA}/${A.size} → ${labelB}: ${solvedB}/${B.size}${regressions ? `  ⚠ ${regressions} regression(s)` : ''}`)
	process.exitCode = regressions ? 1 : 0 // non-zero on regression → usable as a CI gate
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv[0] === '--diff' && argv[1] && argv[2]) diff(argv[1], argv[2])
else if (argv[0] && !argv[0].startsWith('-')) report(argv[0])
else {
	console.error('usage: report.mts <run-label> | report.mts --diff <runA> <runB>')
	process.exit(2)
}
