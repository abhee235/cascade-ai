// scripts/eval/timeline.mts — render a session trace (JSONL) as a readable per-turn TIMELINE.
// The forensic instrument: every model turn with wall time + real token counts, every tool call with its
// outcome, every compaction/nudge/gate/error — so "walk the whole trace" is one command, not ad-hoc greps.
//
//   npx tsx scripts/eval/timeline.mts <trace.jsonl> [--full]
//
// --full prints untruncated model text + tool inputs (default: compact one-liners).

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: args, positionals } = parseArgs({
	options: { full: { type: 'boolean', default: false } },
	allowPositionals: true,
})
const file = positionals[0]
if (!file) {
	console.error('usage: timeline.mts <trace.jsonl> [--full]')
	process.exit(2)
}

const CUT = args.full ? Number.POSITIVE_INFINITY : 160
const one = (s: unknown, cut = CUT): string => String(s ?? '').replace(/\s+/g, ' ').slice(0, cut)

interface Ev {
	ts: string
	t: string
	[k: string]: unknown
}
const events: Ev[] = readFileSync(file, 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l))

const t0 = events.length ? Date.parse(events[0]!.ts) : 0
const at = (e: Ev): string => `+${((Date.parse(e.ts) - t0) / 1000).toFixed(1).padStart(7)}s`

let turn = -1
let lastReqTs = 0
const stats = { turns: 0, tools: 0, toolErrs: 0, compactions: 0, nudges: 0, gates: 0, errors: 0, inTok: 0, outTok: 0 }

for (const e of events) {
	switch (e.t) {
		case 'submit':
			console.log(`${at(e)} ▶ SUBMIT  ${one(e.text, 300)}`)
			break
		case 'model_request': {
			turn = (e.turn as number) ?? turn + 1
			lastReqTs = Date.parse(e.ts)
			const msgs = Array.isArray(e.messages) ? (e.messages as unknown[]).length : '?'
			console.log(`${at(e)} ── turn ${String(turn).padStart(2)} ─ request (${msgs} msgs, system ${String((e.system as string | undefined)?.length ?? '?')}ch)`)
			break
		}
		case 'model_response': {
			stats.turns++
			const u = e.usage as { inputTokens?: number; outputTokens?: number } | undefined
			if (u?.inputTokens) stats.inTok += u.inputTokens
			if (u?.outputTokens) stats.outTok += u.outputTokens
			const dur = lastReqTs ? `${((Date.parse(e.ts) - lastReqTs) / 1000).toFixed(1)}s` : '?'
			const tools = Array.isArray(e.toolUses) ? (e.toolUses as { name: string }[]).map((x) => x.name).join(',') : ''
			const usage = u ? `${u.inputTokens ?? '?'}in/${u.outputTokens ?? '?'}out` : 'no usage'
			console.log(`${at(e)}    reply ${dur} (${usage})${tools ? ` → [${tools}]` : ' → (no tools — terminal)'}`)
			const text = one(e.text)
			if (text) console.log(`${at(e)}      "${text}"`)
			const think = one(e.thinking, args.full ? Number.POSITIVE_INFINITY : 100)
			if (think && args.full) console.log(`${at(e)}      (thinking) ${think}`)
			break
		}
		case 'tool_call':
			stats.tools++
			console.log(`${at(e)}    ⚒ ${e.name}${e.repaired ? ' [args JSON-repaired]' : ''}  ${one(JSON.stringify(e.input))}`)
			break
		case 'tool_result': {
			const ok = e.ok !== false
			if (!ok) stats.toolErrs++
			console.log(`${at(e)}      ${ok ? '✓' : '✗ ERR'} (${e.ms}ms) ${one(e.content)}`)
			break
		}
		case 'permission':
			if (e.asked) console.log(`${at(e)}    🔐 permission asked: ${e.tool} → ${e.decision}`)
			break
		case 'compaction':
			stats.compactions++
			console.log(`${at(e)}    🗜 COMPACT ${e.kind} ${e.tokensBefore}→${e.tokensAfter}${e.forced ? ' (FORCED)' : ''}`)
			break
		case 'delegate_nudge':
			stats.nudges++
			console.log(`${at(e)}    👉 delegation nudge injected`)
			break
		case 'verify_gate':
			stats.gates++
			console.log(`${at(e)}    🚧 verify gate: terminal answer refused, check demanded`)
			break
		case 'question':
			console.log(`${at(e)}    ❔ QUESTION to user: ${one(JSON.stringify(e.questions))}`)
			break
		case 'error':
			stats.errors++
			console.log(`${at(e)}    💥 ERROR ${one(e.message, 300)}`)
			break
		case 'turn_done':
			console.log(`${at(e)} ■ TURN DONE after ${e.turns} model turns`)
			break
	}
}

console.log(
	`\nTOTALS  model-turns ${stats.turns} · tools ${stats.tools} (${stats.toolErrs} err) · compactions ${stats.compactions} · nudges ${stats.nudges} · verify-gates ${stats.gates} · errors ${stats.errors} · tokens ${stats.inTok}in/${stats.outTok}out`,
)
