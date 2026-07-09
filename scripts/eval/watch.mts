// scripts/eval/watch.mts — live milestone watcher for trace JSONL files. Node-native replacement for the
// `tail -F | grep` pipeline that produced ZERO events on Windows during the skills-2 run (git-bash tail on
// an actively-appended NTFS file + pipe buffering — silent, the worst failure mode for a monitor). This
// polls sizes with plain fs reads: boring, unbuffered, works everywhere.
//
//   npx tsx scripts/eval/watch.mts eval/runs/<label>          # milestones from every trace in the run
//   npx tsx scripts/eval/watch.mts path/to/trace.jsonl --all  # every event from one file
//
// Default filter = the milestones a human monitors a run for (skill/agent adoption, nudges, compaction,
// failures). --all dumps everything; --events t1,t2 picks exact TraceEvent `t` values.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		all: { type: 'boolean', default: false },
		events: { type: 'string' },
		interval: { type: 'string', default: '400' }, // ms between polls
	},
})

const target = positionals[0]
if (!target || !existsSync(target)) {
	console.error('usage: watch.mts <run-dir | trace.jsonl> [--all] [--events t1,t2] [--interval ms]')
	process.exit(2)
}

// Piped to `head`/a closing pager, stdout dies with EPIPE — exit quietly instead of a Node stack trace.
process.stdout.on('error', () => process.exit(0))

const wantedEvents = args.events ? new Set(args.events.split(',').map((s) => s.trim())) : undefined

/** All .jsonl files under the target: the file itself, or dir + its traces/ subdir (rescanned every tick
 *  so traces created MID-RUN are picked up — the old pipeline had to be pointed at files that existed). */
function traceFiles(): string[] {
	if (statSync(target!).isFile()) return [target!]
	const dirs = [target!, join(target!, 'traces')]
	const out: string[] = []
	for (const d of dirs) {
		try {
			for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) out.push(join(d, f))
		} catch {
			/* dir absent — fine */
		}
	}
	return out
}

type Row = { ts?: string; t?: string; [k: string]: unknown }

/** One line per milestone — enough to act on, never a wall of JSON. */
function render(row: Row): string | undefined {
	if (typeof row.t !== 'string' && !args.all) return undefined // not a TraceEvent (e.g. results.jsonl rows)
	const t = row.t ?? '?'
	if (wantedEvents) {
		if (!wantedEvents.has(t)) return undefined
	} else if (!args.all) {
		// Milestone filter. tool_call only for the routing decisions we watch adoption of; tool_result only
		// on failure; model_* and routine tool traffic stay out (that's what replay/timeline are for).
		if (t === 'model_request' || t === 'model_response') return undefined
		if (t === 'tool_call' && !['Skill', 'Subagent', 'AskUserQuestion', 'TodoWrite'].includes(row.name as string)) return undefined
		if (t === 'tool_result' && row.ok !== false) return undefined
		if (t === 'permission' && row.asked !== true) return undefined
		if (t === 'hook') return undefined
	}
	switch (t) {
		case 'submit':
			return `submit "${String(row.text).slice(0, 80)}"`
		case 'tool_call':
			return `tool_call ${row.name} ${JSON.stringify(row.input ?? {}).slice(0, 120)}`
		case 'tool_result':
			return `tool_result ${row.name} ${row.ok === false ? 'FAIL' : 'ok'} ${row.ms}ms ${String(row.content ?? '').slice(0, 100)}`
		case 'compaction':
			return `compaction ${row.kind}${row.forced ? ' FORCED' : ''} ${row.tokensBefore}→${row.tokensAfter}`
		case 'verify_gate':
		case 'delegate_nudge':
		case 'plan_nudge':
			return `${t} turn=${row.turn}${row.readTokens ? ` readTokens=${row.readTokens}` : ''}`
		case 'permission':
			return `permission ${row.tool} → ${row.decision}${row.asked ? ' (asked)' : ''}`
		case 'turn_done':
			return `turn_done turns=${row.turns}`
		case 'error':
			return `ERROR ${String(row.message).slice(0, 200)}`
		default:
			return `${t} ${JSON.stringify(row).slice(0, 140)}`
	}
}

// Per-file cursor: byte offset consumed + the trailing partial line (a poll can land mid-write; JSONL is
// only parseable at \n boundaries, so the remainder waits for the next poll).
const cursors = new Map<string, { offset: number; remainder: string }>()
let lastFile = ''

function poll(): void {
	for (const file of traceFiles()) {
		let size: number
		try {
			size = statSync(file).size
		} catch {
			continue // deleted between scan and stat
		}
		const cur = cursors.get(file) ?? { offset: 0, remainder: '' }
		if (!cursors.has(file)) cursors.set(file, cur)
		if (size < cur.offset) Object.assign(cur, { offset: 0, remainder: '' }) // truncated/rewritten → restart
		if (size === cur.offset) continue
		const buf = Buffer.alloc(size - cur.offset)
		let fd: number
		try {
			fd = openSync(file, 'r')
		} catch {
			continue
		}
		try {
			readSync(fd, buf, 0, buf.length, cur.offset)
		} finally {
			closeSync(fd)
		}
		cur.offset = size
		const chunk = cur.remainder + buf.toString('utf8')
		const lines = chunk.split('\n')
		cur.remainder = lines.pop() ?? ''
		for (const line of lines) {
			if (!line.trim()) continue
			let row: Row
			try {
				row = JSON.parse(line)
			} catch {
				continue // torn or foreign line — never crash the monitor
			}
			const text = render(row)
			if (!text) continue
			if (file !== lastFile) {
				console.log(`\n── ${basename(file)} ──`)
				lastFile = file
			}
			console.log(`${(row.ts ?? '').slice(11, 19)}  ${text}`)
		}
	}
}

console.log(`watching ${target} (${args.all ? 'ALL events' : wantedEvents ? [...wantedEvents].join(',') : 'milestones'}; Ctrl-C to stop)`)
poll()
setInterval(poll, Math.max(100, Number(args.interval) || 400))
