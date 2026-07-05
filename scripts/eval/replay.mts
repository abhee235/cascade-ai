// scripts/eval/replay.mts — REPLAY a session from any turn of a trace (user requirement: "it could be
// replayed anytime to test from there"). Every `model_request` event carries the COMPLETE message history
// at that instant, so replay = load that snapshot into a fresh session and continue — with the original
// prompt (re-run the turn) or a new one (poke the state: "what would you do differently if…").
//
//   npx tsx scripts/eval/replay.mts <trace.jsonl> --cwd <workdir> [--turn N] [--prompt "…"] [--model m]
//
//   --turn N     replay from BEFORE model turn N (default: the last turn in the trace)
//   --prompt     the message to submit on top of the restored history (default: a "continue" nudge)
//   --cwd        the workspace files AS OF that point — use builder.mts --keep to preserve one, or a copy
//                of a real project. (The trace restores the CONVERSATION; the cwd restores the FILES.)
//
// Same model/provider flags as the other runners. The replayed turn writes its own trace next to stdout.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createProvider, createSession, JsonlTracer, type Message } from '@cascade/core'

const { values: args, positionals } = parseArgs({
	options: {
		cwd: { type: 'string' },
		turn: { type: 'string' },
		prompt: { type: 'string' },
		model: { type: 'string', default: 'qwen36-agentic:latest' },
		provider: { type: 'string', default: 'ollama' },
		'base-url': { type: 'string' },
		'context-window': { type: 'string' },
		trace: { type: 'string' }, // output trace path for the replayed continuation
	},
	allowPositionals: true,
})
const file = positionals[0]
if (!file || !args.cwd) {
	console.error('usage: replay.mts <trace.jsonl> --cwd <workdir> [--turn N] [--prompt "…"] [--model m]')
	process.exit(2)
}

const events = readFileSync(file, 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l))

const requests = events.filter((e) => e.t === 'model_request')
if (requests.length === 0) {
	console.error('trace has no model_request events — nothing to replay')
	process.exit(1)
}
const turn = args.turn !== undefined ? Number(args.turn) : (requests[requests.length - 1].turn as number)
const req = requests.findLast((e) => e.turn === turn) ?? requests[requests.length - 1]
const history = req.messages as Message[]
console.log(`replaying from turn ${req.turn} — restored ${history.length} history messages (of ${requests.length} recorded turns)`)

const session = createSession({
	cwd: resolve(args.cwd),
	provider: createProvider({ provider: args.provider!, model: args.model!, baseUrl: args['base-url'] }),
	model: args.model!,
	mode: 'bypass',
	autoMemory: false,
	tracer: args.trace ? new JsonlTracer(args.trace) : undefined,
	contextWindow: args['context-window'] ? Number(args['context-window']) : undefined,
})
session.loadHistory(history)

const prompt = args.prompt ?? 'Continue exactly where you left off. Re-check the current state of the files first if unsure.'
for await (const ev of session.submit(prompt)) {
	if (ev.type === 'status') process.stderr.write(`[${ev.text}]\n`)
	else if (ev.type === 'toolStart') process.stderr.write(`  ⚒ ${ev.name} ${ev.summary}\n`)
	else if (ev.type === 'toolResult') process.stderr.write(`    ${ev.ok ? '✓' : '✗'} ${ev.preview.slice(0, 120).replace(/\s+/g, ' ')}\n`)
	else if (ev.type === 'compacted') process.stderr.write(`  🗜 compacted (${ev.kind})\n`)
	else if (ev.type === 'question') session.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
	else if (ev.type === 'permission') session.respondPermission(ev.id, 'allow')
	else if (ev.type === 'message') {
		const text = typeof ev.message.content === 'string' ? ev.message.content : ev.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
		if (text) console.log(`\n${text}\n`)
	}
}
await session.dispose().catch(() => {})
