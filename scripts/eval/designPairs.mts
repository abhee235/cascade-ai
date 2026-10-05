// designPairs.mts — BLIND pairwise review for a design bench (ADR-085 P0 oracle; the human half of the judge's
// calibration). Two modes:
//
//   make:  npx tsx scripts/eval/designPairs.mts --rescore <dir> --base <labelA> --vs <labelB> [--vs …] --out <dir>
//          Pairs each --vs run with the --base run of the same scenario and repeat (shop-a1 with shop-a1, …),
//          sides shuffled by a recorded seed. Writes <out>/index.html (screenshots only, no arm names) and
//          <out>/key.json (which side is which) — the page never loads the key.
//   score: npx tsx scripts/eval/designPairs.mts --score <picks.json> --out <dir>
//          Joins the exported picks with the key: per comparison, how often the challenger beat the base.
//
// A seeded run whose built CSS lost the seed (`seed.kept: false`) drifted back to a shipped preset: its pair is
// dropped and counted, never judged — the oracle compares the seed, not a run that silently abandoned it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
	options: { rescore: { type: 'string' }, base: { type: 'string' }, vs: { type: 'string', multiple: true }, out: { type: 'string' }, score: { type: 'string' }, seed: { type: 'string', default: '20260927' } },
})
if (!args.out) throw new Error('--out <dir> is required')

interface Shot { view: string; file: string }
interface Pair {
	id: string
	comparison: string
	scenario: string
	repeat: string
	left: string
	right: string
	shots: { left: Shot[]; right: Shot[] }
	/** Decided without review: one side failed to build (the side that built wins), or both did (a tie). A
	 *  failed build is that arm's real outcome — excluding it would tilt the comparison toward the arm that
	 *  failed. Only a DRIFT (built fine, but with another preset) is dropped. */
	auto?: 'left' | 'right' | 'tie'
}

/** mulberry32 — a tiny seeded PRNG, so the side assignment is reproducible from key.json's seed. */
function prng(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

if (args.score) {
	const key = JSON.parse(readFileSync(join(args.out, 'key.json'), 'utf8')) as { pairs: Pair[] }
	const picks = JSON.parse(readFileSync(args.score, 'utf8')) as Record<string, { pick: 'left' | 'right' | 'tie'; note?: string }>
	const tally: Record<string, { challengerWins: number; baseWins: number; ties: number; unjudged: number; notes: string[] }> = {}
	for (const p of key.pairs) {
		const t = (tally[p.comparison] ??= { challengerWins: 0, baseWins: 0, ties: 0, unjudged: 0, notes: [] })
		const pick = p.auto ?? picks[p.id]?.pick
		const challengerSide = p.left === p.comparison.split('-vs-')[0] ? 'left' : 'right'
		if (!pick) t.unjudged++
		else if (pick === 'tie') t.ties++
		else if (pick === challengerSide) t.challengerWins++
		else t.baseWins++
		if (picks[p.id]?.note) t.notes.push(`${p.id}: ${picks[p.id]!.note}`)
	}
	for (const [c, t] of Object.entries(tally)) {
		const judged = t.challengerWins + t.baseWins + t.ties
		console.log(`${c}: challenger won ${t.challengerWins}/${judged} (base ${t.baseWins}, ties ${t.ties}${t.unjudged ? `, unjudged ${t.unjudged}` : ''})`)
		for (const n of t.notes) console.log(`   ${n}`)
	}
	process.exit(0)
}

if (!args.rescore || !args.base || !args.vs?.length) throw new Error('make mode needs --rescore <dir> --base <label> --vs <label>')
const load = (label: string) => JSON.parse(readFileSync(join(args.rescore!, label, 'metrics.json'), 'utf8')) as any[]
const shotsOf = (run: any): Shot[] =>
	(run.design.passes['light-1440'] ?? []).filter((v: any) => v.reached && existsSync(v.shot)).map((v: any) => ({ view: v.name, file: v.shot }))
const random = prng(Number(args.seed))
const pairs: Pair[] = []
const dropped: string[] = []
const base = load(args.base)
for (const label of args.vs) {
	const comparison = `${label}-vs-${args.base}`
	for (const run of load(label)) {
		const tag = String(run.runId).replace(/^builder-/, '')
		const partner = base.find((b) => b.runId === run.runId)
		if (!partner) continue
		if (run.seed?.built && run.seed.built !== run.seed.id) {
			dropped.push(`${comparison} ${tag}: drifted — built ${run.seed.built}, not the seed ${run.seed.id}`)
			continue
		}
		const flip = random() < 0.5
		const [left, right] = flip ? [label, args.base] : [args.base, label]
		const built = (r: any) => Boolean(r.buildOk) && shotsOf(r).length > 0
		const [runBuilt, baseBuilt] = [built(run), built(partner)]
		const challengerSide = flip ? 'left' : 'right'
		const baseSide = flip ? 'right' : 'left'
		const auto = runBuilt && baseBuilt ? undefined : runBuilt ? challengerSide : baseBuilt ? baseSide : 'tie'
		pairs.push({ id: `p${pairs.length + 1}`, comparison, scenario: run.scenario, repeat: tag, left, right, shots: { left: shotsOf(flip ? run : partner), right: shotsOf(flip ? partner : run) }, ...(auto ? { auto } : {}) })
	}
}
// Present in a shuffled order too, so consecutive pairs never reveal a comparison's run of repeats. Pairs a
// failed build decided are not shown — there is nothing to look at — but they are scored.
const order = pairs.filter((p) => !p.auto).map((p) => ({ p, k: random() })).sort((a, b) => a.k - b.k).map((x) => x.p)
const autoCount = pairs.length - order.length
// Ids follow the DISPLAY order, so neither an id nor an image name hints at which comparison a pair belongs to.
order.forEach((p, i) => (p.id = `q${i + 1}`))
pairs.filter((p) => p.auto).forEach((p, i) => (p.id = `auto${i + 1}`))
mkdirSync(join(args.out, 'img'), { recursive: true })
writeFileSync(join(args.out, 'key.json'), JSON.stringify({ seed: Number(args.seed), base: args.base, vs: args.vs, dropped, pairs }, null, 2))
// BLINDING: a screenshot's own path names its arm (…/oracle-B-qwen36/shop-a1-…png), and clicking it open shows
// that path in the address bar. Every shown image is copied under a neutral name: <pair>-<L|R>-<n>.png.
for (const p of order) {
	for (const [side, key] of [['L', 'left'], ['R', 'right']] as const) {
		p.shots[key] = p.shots[key].map((s, n) => {
			const file = join(args.out!, 'img', `${p.id}-${side}-${n + 1}.png`)
			copyFileSync(s.file, file)
			return { view: s.view, file }
		})
	}
}

// The page: screenshots and a pick per pair — no arm names anywhere. Picks persist in this browser only
// (localStorage) and leave through Export (a download, plus a copyable text box).
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const src = (f: string) => relative(args.out!, f).replaceAll('\\', '/')
const column = (side: string, shots: Shot[]) =>
	`<div class="col"><h3>${side}</h3>${shots.map((s) => `<figure><figcaption>${esc(s.view.replace(/^\d-/, ''))}</figcaption><a href="${esc(src(s.file))}" target="_blank"><img loading="lazy" src="${esc(src(s.file))}" alt="${side} — ${esc(s.view)}"></a></figure>`).join('') || '<p class="none">no reachable views</p>'}</div>`
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blind design review</title><style>
:root{--bg:#f7f7f5;--fg:#1b1b1b;--muted:#5f5f5a;--card:#fff;--line:#dcdcd6;--pick:#1d4ed8;--pick-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#a3a3a3;--card:#1e1e1e;--line:#333;--pick:#60a5fa;--pick-fg:#0b0b0b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1400px;margin:0 auto;padding:24px 16px 96px}h1{font-size:22px;margin:0 0 8px}.lede{color:var(--muted);max-width:75ch}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:24px 0}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.head h2{font-size:17px;margin:0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}.col h3{font-size:14px;margin:0 0 8px;color:var(--muted)}
figure{margin:0 0 12px}figcaption{font-size:12px;color:var(--muted)}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px;display:block}
.pick{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pick button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.pick button[aria-pressed=true]{background:var(--pick);color:var(--pick-fg);border-color:var(--pick)}textarea{width:100%;margin-top:8px;font:inherit;background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center}
.bar button{font:inherit;padding:8px 14px;border-radius:8px;border:0;background:var(--pick);color:var(--pick-fg);cursor:pointer}.none{color:var(--muted)}
@media (max-width:720px){.cols{grid-template-columns:1fr}}
</style></head><body><main>
<h1>Blind design review</h1>
<p class="lede">For each pair, pick the app you would rather ship. Judge the whole thing: does it fit its subject, is the hierarchy clear, is the imagery real, do the sections have rhythm and variety, is it polished, and is it free of the default-template tells? A tie is a fine answer. You don't know which build is which — that's the point. Your picks are saved in this browser as you go; press Export when done.${autoCount ? ` (${autoCount} more pair${autoCount > 1 ? 's were' : ' was'} decided automatically because a build failed — nothing to judge.)` : ''}</p>
${order.map((p, i) => `<section data-id="${p.id}"><div class="head"><h2>Pair ${i + 1} of ${order.length} · ${esc(p.scenario.replace(/^builder-/, ''))}</h2></div>
<div class="cols">${column('Left', p.shots.left)}${column('Right', p.shots.right)}</div>
<div class="pick" role="group" aria-label="Pick for pair ${i + 1}"><button data-v="left">Left is better</button><button data-v="tie">Tie</button><button data-v="right">Right is better</button></div>
<textarea rows="2" placeholder="Optional note — what decided it?"></textarea></section>`).join('\n')}
</main><div class="bar"><span id="count"></span><button id="export">Export picks</button></div>
<textarea id="out" rows="6" style="display:none;position:fixed;left:16px;right:16px;bottom:64px;width:auto;background:var(--card)"></textarea>
<script>
const KEY = 'design-pairs-${Number(args.seed)}-${order.length}'
let picks = {}
try { picks = JSON.parse(localStorage.getItem(KEY) || '{}') } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(picks)) } catch {} ; render() }
const render = () => {
  document.querySelectorAll('section').forEach((s) => {
    const p = picks[s.dataset.id] || {}
    s.querySelectorAll('.pick button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === p.pick)))
    const t = s.querySelector('textarea'); if (document.activeElement !== t) t.value = p.note || ''
  })
  document.getElementById('count').textContent = Object.values(picks).filter((p) => p.pick).length + ' of ${order.length} judged'
}
document.querySelectorAll('section').forEach((s) => {
  s.querySelectorAll('.pick button').forEach((b) => b.addEventListener('click', () => { picks[s.dataset.id] = { ...(picks[s.dataset.id] || {}), pick: b.dataset.v }; save() }))
  s.querySelector('textarea').addEventListener('input', (e) => { picks[s.dataset.id] = { ...(picks[s.dataset.id] || {}), note: e.target.value }; save() })
})
document.getElementById('export').addEventListener('click', () => {
  const json = JSON.stringify(picks, null, 2), out = document.getElementById('out')
  out.style.display = 'block'; out.value = json; out.select()
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'picks.json'; a.click()
})
render()
</script></body></html>`
writeFileSync(join(args.out, 'index.html'), html)
console.log(`${order.length} pairs to judge → ${join(args.out, 'index.html')}`)
for (const p of pairs.filter((q) => q.auto)) console.log(`auto ${p.id} ${p.comparison} ${p.repeat}: ${p.auto === 'tie' ? 'both failed to build' : `${p.auto === 'left' ? p.left : p.right} wins — the other side failed to build`}`)
if (dropped.length) console.log(`dropped (drifted to another preset): ${dropped.length}\n  ${dropped.join('\n  ')}`)
