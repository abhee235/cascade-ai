// builder-fullstack check — the 12-round incremental full-stack ladder (Studio Manager).
//
// ROUND-GATED: EVAL_ROUND=<n> asserts only what rounds 1..n asked for (the runner's checkEachRound
// instrumentation); unset = the full bar. Assertions are MONOTONIC by construction — round n's assert
// still holds for the finished app (verify enforces this by running the solution at every bar), so a
// live run's per-round ✓/✗ marks form an honest degradation curve.
//
// BEHAVIORAL, unlike builder-graduate: this check actually BOOTS the Express server (tsx over the shared
// junction deps — installed once into eval/external/builder-template) against a FRESH database
// (`prisma db push --force-reset`, which also regenerates the client) and asserts the API contracts the
// prompts pinned: seeding, CRUD, validation, the {items,total} envelope, search, pagination, stats math,
// the auth wall, CSV, and the 409/2-decimal hardening. Restart persistence is proved by killing the
// server and booting a second one on the same database file.
//
// Shared-junction caveat (accepted): `db push` regenerates node_modules/.prisma for THIS schema. Within
// a fullstack run that is exactly right (the model's own db:generate did the same); across fixtures the
// only other Prisma user is builder-graduate, whose check never touches the client.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runDesignLint } from '../_lib/designLint.mjs'
import { noResidue } from '../_lib/residue.mjs'

const ROUND = Number(process.env.EVAL_ROUND ?? '12')
const at = (n) => ROUND >= n // "the bar includes round n's asks"

// COLLECT mode (EVAL_COLLECT=1): report EVERY failing assertion instead of the first — the TemplateAudit
// pattern. Measured need (fullstack-v3, 2026-08-23): feeding a model only the FIRST failure per round
// induced whack-a-mole — it tunnel-visioned on that one item and broke others fixing it; the failure
// ROTATED every round and nothing converged. Cumulative findings are what the product's own audit gate
// feeds back, and what a fix-round needs to plan against.
// Mechanics: independent assertions (surfaces, source artifacts, lint) simply record and continue; inside
// the BEHAVIORAL section a failed assert still aborts the section (later asserts depend on earlier state),
// recorded as that section's one finding.
const COLLECT = process.env.EVAL_COLLECT === '1'
const failures = []
let behavioral = false // flipped once server asserts begin — from there, fail() must abort the section
class CheckFail extends Error {}

const fail = (msg) => {
	if (!COLLECT) {
		console.error(`builder-fullstack[r${ROUND}]: ${msg}`)
		process.exit(1)
	}
	failures.push(msg)
	if (behavioral) throw new CheckFail(msg)
}

const finish = () => {
	if (COLLECT && failures.length > 0) {
		console.error(`FAILING (${failures.length}):`)
		for (const f of failures) console.error(`- ${f}`)
		process.exit(1)
	}
	console.log(`builder-fullstack check passed at round ${ROUND} bar`)
	process.exit(0)
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const round2 = (n) => Math.round(n * 100) / 100

// ── 1) The frontend builds, at every bar ────────────────────────────────────────────────────────────────
// In COLLECT mode a build failure records and CONTINUES — but everything bundle-derived must then be
// SKIPPED, not attempted (measured, v4 r3–r11: marching into readdirSync of a dist that doesn't exist
// turned nine rounds of real "build broken" verdicts into raw ENOENT instrument crashes).
const build = spawnSync(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { encoding: 'utf8', timeout: 180_000 })
const buildOk = build.status === 0
if (!buildOk) fail(`vite build FAILED:\n${(build.stderr || build.stdout).slice(-1500)}`)
const bundle = buildOk
	? readdirSync(join('dist', 'assets'))
			.filter((f) => f.endsWith('.js'))
			.map((f) => readFileSync(join('dist', 'assets', f), 'utf8'))
			.join('\n')
	: ''
const hay = bundle.toLowerCase()

// ── 2) Bundle surface ladder (case-insensitive, per the shop check's measured rule) ────────────────────
// SYNONYMS (calibrated 2026-08-22 against a real iq3 run): a working create-invoice button labeled
// "Create invoice" was marked ✗ for 8 straight rounds because the brief said "New invoice". What these
// assertions measure is that the SURFACE exists; for action buttons the label wording is not the
// variable — a check that fails correct work teaches models to game the bar (the shop check's own
// case-insensitivity lesson, one level up). IDENTITY strings (the app name) and copy the brief pins as
// EXACT (the search placeholder) stay single-valued.
const SURFACES = [
	[1, ['Studio Manager'], 'the app name (NavBar brand)'],
	[1, ['Dashboard'], 'the Dashboard nav entry'],
	[1, ['Invoices'], 'the Invoices nav entry'],
	[1, ['No clients yet', 'No clients'], 'the Clients empty state'],
	[3, ['Retry', 'Try again'], 'the error-state retry button'],
	[4, ['New client', 'Add client', 'Create client'], 'the create-client button'],
	[5, ['New invoice', 'Add invoice', 'Create invoice'], 'the create-invoice button'],
	[5, ['Add line', 'Add item', 'Add row'], 'the line-items editor'],
	[6, ['Search clients…'], 'the exact search placeholder'],
	[7, ['Previous', 'Prev'], 'pagination controls'],
	[7, ['Next'], 'pagination controls'],
	[8, ['Revenue by month', 'Monthly revenue'], 'the dashboard chart title'],
	[8, ['Outstanding'], 'the outstanding KPI'],
	[9, ['Sign in', 'Log in'], 'the auth screen submit'],
	[9, ['Sign out', 'Log out'], 'the signed-in nav action'],
	[10, ['Export CSV', 'Download CSV'], 'the invoice export button'],
]
if (buildOk)
	for (const [n, needles, what] of SURFACES) {
		if (at(n) && !needles.some((needle) => hay.includes(needle.toLowerCase()))) {
			fail(`bundle is missing "${needles[0]}" (or a synonym: ${needles.join(' / ')}) — ${what} (round ${n})`)
		}
	}

// ── 3) Source-side graduation artifacts (builder-graduate's contract, round 2+) ────────────────────────
if (at(2)) {
	for (const f of ['server/index.ts', 'prisma/schema.prisma', 'src/lib/storage.api.ts']) {
		if (!existsSync(f)) fail(`missing "${f}" — the backend pack was not applied via ApplyPack (round 2)`)
	}
	const schema = read('prisma/schema.prisma')
	if (!/^\s*model\s+Client\s*\{/m.test(schema)) fail('prisma/schema.prisma has no `model Client` (round 2)')
	if (at(5) && !/^\s*model\s+Invoice\s*\{/m.test(schema)) fail('prisma/schema.prisma has no `model Invoice` (round 5)')
	if (at(5) && !/^\s*model\s+InvoiceItem\s*\{/m.test(schema)) fail('prisma/schema.prisma has no `model InvoiceItem` (round 5)')
	if (at(9) && !/^\s*model\s+User\s*\{/m.test(schema)) fail('prisma/schema.prisma has no `model User` (round 9)')
	const seam = read(join('src', 'lib', 'storage.ts'))
	if (!/createApiStore/.test(seam) && !/from ['"]\.\/storage\.api['"]/.test(seam)) {
		fail('src/lib/storage.ts was not switched to the API store — the seam did not graduate (round 2)')
	}
}
if (at(12)) {
	if (!/themes\/luxe-dark\.css/.test(read(join('src', 'index.css')))) fail("src/index.css does not import ./themes/luxe-dark.css — the Restyle round didn't land (round 12)")
}

// ── 4) Design lint + residue, block ladder growing with the app ────────────────────────────────────────
const blocks = ['navbar', 'empty-state']
if (at(5)) blocks.push('data-table')
if (at(8)) blocks.push('stat-card', 'chart-card')
if (at(9)) blocks.push('auth-card')
if (buildOk && runDesignLint(bundle, { blocks, preset: at(12) ? 'luxe-dark' : '*', quality: process.env.EVAL_BAR === 'quality', imagery: false }) > 0) fail('design lint failed (findings printed above)')
if (noResidue(process.cwd()) > 0) fail('template residue remains (findings printed above)')

// ── 5) The API, behaviorally (round 2+) ─────────────────────────────────────────────────────────────────
if (!at(2)) finish()

const PORT = 18700 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`
const TSX = join('node_modules', 'tsx', 'dist', 'cli.mjs')
const PRISMA = join('node_modules', 'prisma', 'build', 'index.js')

// Fresh, deterministic database: DELETING the file is the reset (no --force-reset — Prisma 6 gates that
// flag behind an interactive consent prompt when it detects an agent, which would wedge every check).
// A plain `db push` onto the now-absent file creates the schema and re-generates the client.
// LOCKED-FILE fallback (measured, v5 r3/r5: the model's own API server holds dev.db open and Windows
// EPERMs the delete — a naked rmSync crashed the whole check): when the file won't delete, wipe the DATA
// through SQLite instead. Concurrent access is what SQLite is for; schema stays, `db push` aligns it,
// and the seed repopulates — identical reset semantics either way.
try {
	rmSync(join('prisma', 'dev.db'), { force: true })
	rmSync(join('prisma', 'dev.db-journal'), { force: true })
} catch {
	/* fall through to the SQL wipe below */
}
if (existsSync(join('prisma', 'dev.db'))) {
	try {
		const { DatabaseSync } = await import('node:sqlite')
		// FK enforcement OFF for the wipe connection (Node's DatabaseSync enables it by default — measured,
		// v6 r7/r8: deleting Client rows before their invoices threw "FOREIGN KEY constraint failed" and the
		// reset died). Per-connection pragma; the app's own connections keep their setting.
		const db = new DatabaseSync(join('prisma', 'dev.db'), { enableForeignKeyConstraints: false })
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'").all()
		for (const t of tables) db.exec(`DELETE FROM "${t.name}"`)
		db.close()
	} catch (e) {
		fail(`database reset failed — dev.db is locked and the SQL wipe also failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
	}
}
const push = spawnSync(process.execPath, [PRISMA, 'db', 'push', '--schema', join('prisma', 'schema.prisma')], { encoding: 'utf8', timeout: 120_000 })
if (push.status !== 0) fail(`prisma db push failed:\n${(push.stderr || push.stdout).slice(-1200)}`)

// BOTH house seeding idioms are legal (measured 2026-08-21: the model follows the backend SKILL's
// prisma/seed.ts + db:seed pattern over a prompt line demanding boot-seeding — when fixture and skill
// disagree, the model sides with the skill, so the fixture must accept the house idiom): a seed script
// is run here if it exists; a server that instead self-seeds on boot fills the same rows a moment later.
if (existsSync(join('prisma', 'seed.ts'))) {
	const seeded = spawnSync(process.execPath, [TSX, join('prisma', 'seed.ts')], { encoding: 'utf8', timeout: 90_000 })
	if (seeded.status !== 0) fail(`prisma/seed.ts exists but failed:\n${(seeded.stderr || seeded.stdout).slice(-800)}`)
}


let server
const bootServer = async () => {
	server = spawn(process.execPath, [TSX, join('server', 'index.ts')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
	let logs = ''
	server.stdout.on('data', (d) => { logs += d })
	server.stderr.on('data', (d) => { logs += d })
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${BASE}/api/health`)
			if (r.ok) return
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 500))
	}
	fail(`server never answered /api/health on :${PORT}\n${logs.slice(-1200)}`)
}
const killServer = () => {
	if (!server) return
	if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
	else server.kill('SIGKILL')
	server = undefined
}
process.on('exit', killServer)

let cookie = '' // the sid session cookie once the auth wall exists
const req = async (method, path, body, opts = {}) => {
	const r = await fetch(`${BASE}${path}`, {
		method,
		headers: { 'content-type': 'application/json', ...(cookie && !opts.noAuth ? { cookie } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const text = await r.text()
	let json
	try { json = JSON.parse(text) } catch { /* CSV etc. stay text */ }
	return { status: r.status, json, text, headers: r.headers }
}
// Both list shapes are legal before round 6 (bare array from the pack's generic router, or the envelope);
// FROM round 6 the envelope is the contract.
const listOf = (j, what) => {
	if (Array.isArray(j)) {
		if (at(6)) fail(`${what} still returns a bare array — round 6 required the {items,total} envelope`)
		return { items: j, total: j.length }
	}
	if (!j || !Array.isArray(j.items) || typeof j.total !== 'number') fail(`${what} returned neither an array nor {items,total}: ${JSON.stringify(j).slice(0, 200)}`)
	return j
}
// MONOTONICITY: the FINISHED app has the auth wall, so login is attempted at EVERY bar — quietly. Before
// round 9 a mid-build app has no /api/auth and the attempt just fails (no wall to pass); the finished app
// hands us the cookie. Only the round-9 bar ASSERTS the wall exists.
const login = async ({ required }) => {
	const r = await req('POST', '/api/auth/login', { email: 'owner@studio.local', password: 'studio123' }, { noAuth: true })
	if (r.status !== 200) {
		if (required) fail(`login as the seeded owner failed: HTTP ${r.status} ${r.text.slice(0, 200)}`)
		return
	}
	const sid = (r.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0]
	if (!sid) {
		if (required) fail(`login did not set an sid cookie (got: ${(r.headers.get('set-cookie') ?? '').slice(0, 120)})`)
		return
	}
	cookie = sid
}

behavioral = true // from here, a failed assert aborts the section (later asserts depend on earlier state)
try {
await bootServer()
await login({ required: false })

// Round 9+: the wall itself — unauthenticated /api/* (excl. auth/health) must 401.
if (at(9)) {
	const walled = await req('GET', '/api/clients', undefined, { noAuth: true })
	if (walled.status !== 401) fail(`unauthenticated GET /api/clients returned ${walled.status}, expected 401 (round 9)`)
	const badLogin = await req('POST', '/api/auth/login', { email: 'owner@studio.local', password: 'wrong-password' }, { noAuth: true })
	if (badLogin.status !== 401) fail(`bad-credential login returned ${badLogin.status}, expected 401 (round 9)`)
	await login({ required: true })
	const me = await req('GET', '/api/auth/me')
	if (me.status !== 200 || me.json?.email !== 'owner@studio.local') fail(`/api/auth/me with a session returned ${me.status} ${me.text.slice(0, 120)} (round 9)`)
}

// Round 2: seeding + client CRUD.
{
	const r = await req('GET', '/api/clients?perPage=50')
	if (r.status !== 200) fail(`GET /api/clients → HTTP ${r.status} ${r.text.slice(0, 200)}`)
	const { items, total } = listOf(r.json, 'GET /api/clients')
	if (total < 6 || items.length < 6) fail(`expected the 6 seeded clients, got total=${total} items=${items.length} (round 2 seeding)`)
	const aurora = items.find((c) => c.name === 'Aurora Textiles')
	if (!aurora || aurora.email !== 'hello@auroratextiles.example') fail(`seeded client 'Aurora Textiles' <hello@auroratextiles.example> is missing (round 2 seeding)`)

	const created = await req('POST', '/api/clients', { name: 'Check Probe', email: 'probe@check.example', company: 'Probe Co' })
	if (created.status !== 201) fail(`POST /api/clients → HTTP ${created.status}, expected 201 (round 2)`)
	const id = created.json?.id
	if (id === undefined) fail('POST /api/clients response carries no id (round 2)')
	const got = await req('GET', `/api/clients/${id}`)
	if (got.status !== 200 || got.json?.name !== 'Check Probe') fail(`GET /api/clients/${id} did not return the created client (round 2)`)
	const put = await req('PUT', `/api/clients/${id}`, { name: 'Check Probe 2', email: 'probe@check.example' })
	if (put.status !== 200) fail(`PUT /api/clients/${id} → HTTP ${put.status} (round 2)`)
	if (at(4)) {
		const invalid = await req('POST', '/api/clients', { name: '', email: '' })
		if (invalid.status !== 400 || !invalid.json?.error) fail(`POST /api/clients with empty name/email returned ${invalid.status}, expected 400 {error} (round 4)`)
	}
	const del = await req('DELETE', `/api/clients/${id}`)
	if (del.status !== 204 && del.status !== 200) fail(`DELETE /api/clients/${id} → HTTP ${del.status} (round 2)`)
	const gone = await req('GET', `/api/clients/${id}`)
	if (gone.status !== 404) fail(`deleted client still answers HTTP ${gone.status}, expected 404 (round 2)`)
}

// Round 5+: invoices — seeding, computed totals, validation.
if (at(5)) {
	const r = await req('GET', '/api/invoices?perPage=50')
	if (r.status !== 200) fail(`GET /api/invoices → HTTP ${r.status} ${r.text.slice(0, 200)}`)
	const { items, total } = listOf(r.json, 'GET /api/invoices')
	if (total < 9) fail(`expected the 9 seeded invoices, got total=${total} (round 5 seeding)`)
	for (const status of ['draft', 'sent', 'paid']) {
		if (items.filter((i) => i.status === status).length < 3) fail(`fewer than 3 seeded '${status}' invoices (round 5 seeding: exactly 3/3/3)`)
	}
	const inv = items.find((i) => Array.isArray(i.items) && i.items.length > 0)
	if (!inv) fail('invoices carry no line items in the list payload (round 5)')
	if (typeof inv.clientName !== 'string' || !inv.clientName) fail('invoice rows carry no clientName (round 5)')
	const expected = round2(inv.items.reduce((s, li) => s + li.qty * li.unitPrice, 0))
	if (Math.abs(inv.total - expected) > 0.011) fail(`invoice ${inv.id} total ${inv.total} ≠ Σ qty×unitPrice = ${expected} (round 5 server-computed totals)`)

	const noItems = await req('POST', '/api/invoices', { clientId: inv.clientId, status: 'draft', items: [] })
	if (noItems.status !== 400) fail(`POST /api/invoices with empty items returned ${noItems.status}, expected 400 (round 5)`)
	const badClient = await req('POST', '/api/invoices', { clientId: 999999, status: 'draft', items: [{ description: 'x', qty: 1, unitPrice: 1 }] })
	if (badClient.status !== 400) fail(`POST /api/invoices with unknown clientId returned ${badClient.status}, expected 400 (round 5)`)
}

// Round 6+: search + status filter.
if (at(6)) {
	const s = await req('GET', '/api/clients?search=aurora')
	const { items, total } = listOf(s.json, 'GET /api/clients?search=')
	if (total !== 1 || items[0]?.name !== 'Aurora Textiles') fail(`?search=aurora → total=${total} first=${items[0]?.name} — expected exactly the seeded Aurora Textiles (round 6)`)
	const f = await req('GET', '/api/invoices?status=sent&perPage=50')
	const sent = listOf(f.json, 'GET /api/invoices?status=')
	if (sent.total < 3 || !sent.items.every((i) => i.status === 'sent')) fail(`?status=sent returned ${sent.total} rows incl. non-sent — filter broken (round 6)`)
}

// Round 7+: pagination.
if (at(7)) {
	const p1 = listOf((await req('GET', '/api/clients?page=1&perPage=4')).json, 'page 1')
	if (p1.items.length !== 4) fail(`page=1&perPage=4 returned ${p1.items.length} items, expected 4 (round 7)`)
	if (p1.total < 6) fail(`pagination total=${p1.total} lost the full match count (round 7)`)
	const far = listOf((await req('GET', '/api/clients?page=999&perPage=4')).json, 'page 999')
	if (far.items.length !== 0) fail(`out-of-range page returned ${far.items.length} items, expected empty (round 7)`)
}

// Round 8+: stats math, recomputed from the live invoice list.
if (at(8)) {
	const all = listOf((await req('GET', '/api/invoices?perPage=50')).json, 'invoices for stats')
	const sum = (st) => round2(all.items.filter((i) => i.status === st).reduce((s, i) => s + i.total, 0))
	const stats = (await req('GET', '/api/stats')).json
	if (!stats) fail('GET /api/stats returned no JSON (round 8)')
	if (Math.abs(stats.outstandingTotal - sum('sent')) > 0.011) fail(`stats.outstandingTotal ${stats.outstandingTotal} ≠ Σ sent ${sum('sent')} (round 8)`)
	if (Math.abs(stats.paidTotal - sum('paid')) > 0.011) fail(`stats.paidTotal ${stats.paidTotal} ≠ Σ paid ${sum('paid')} (round 8)`)
	if (!Array.isArray(stats.revenueByMonth) || stats.revenueByMonth.length !== 6) fail(`stats.revenueByMonth must be 6 entries, got ${stats.revenueByMonth?.length} (round 8)`)
	if (!stats.revenueByMonth.every((m) => /^\d{4}-\d{2}$/.test(m.month))) fail('revenueByMonth months are not YYYY-MM (round 8)')
	const monthSum = round2(stats.revenueByMonth.reduce((s, m) => s + m.total, 0))
	const liveSum = round2(sum('sent') + sum('paid'))
	if (Math.abs(monthSum - liveSum) > 0.011) fail(`Σ revenueByMonth ${monthSum} ≠ Σ sent+paid ${liveSum} (round 8)`)
}

// Round 9+: register/logout round-trip (the wall + owner login already proved above).
if (at(9)) {
	const email = `probe-${Date.now()}@check.example`
	const reg = await req('POST', '/api/auth/register', { email, password: 'longenough123' }, { noAuth: true })
	if (reg.status !== 201) fail(`register returned ${reg.status}, expected 201 (round 9)`)
	const short = await req('POST', '/api/auth/register', { email: `x${email}`, password: 'short' }, { noAuth: true })
	if (short.status !== 400) fail(`register with a 5-char password returned ${short.status}, expected 400 (round 9)`)
}

// Round 10+: CSV.
if (at(10)) {
	const csv = await req('GET', '/api/invoices/export.csv')
	if (csv.status !== 200) fail(`export.csv → HTTP ${csv.status} (round 10)`)
	const lines = csv.text.trim().split('\n')
	if (lines[0].trim() !== 'id,client,status,total,date') fail(`CSV header is "${lines[0]}", expected "id,client,status,total,date" (round 10)`)
	const all = listOf((await req('GET', '/api/invoices?perPage=50')).json, 'invoices for csv')
	if (lines.length - 1 !== all.total) fail(`CSV has ${lines.length - 1} rows, invoice total is ${all.total} (round 10)`)
	if (!lines.slice(1).every((l) => /,\d+\.\d{2},\d{4}-\d{2}-\d{2}\s*$/.test(l))) fail('CSV rows must end with a 2-decimal total and a YYYY-MM-DD date (round 10)')
	const paid = await req('GET', '/api/invoices/export.csv?status=paid')
	const paidRows = paid.text.trim().split('\n').length - 1
	const paidTotal = listOf((await req('GET', '/api/invoices?status=paid&perPage=50')).json, 'paid for csv').total
	if (paidRows !== paidTotal) fail(`filtered CSV rows ${paidRows} ≠ paid invoices ${paidTotal} (round 10)`)
}

// Round 11+: hardening — the 409, line-item validation, 2-decimal totals everywhere.
if (at(11)) {
	const all = listOf((await req('GET', '/api/invoices?perPage=50')).json, 'invoices for 409')
	const withInvoices = all.items[0]?.clientId
	if (withInvoices === undefined) fail('no invoice rows to derive a client for the 409 test (round 11)')
	const veto = await req('DELETE', `/api/clients/${withInvoices}`)
	if (veto.status !== 409 || !veto.json?.error) fail(`deleting a client with invoices returned ${veto.status}, expected 409 {error} (round 11)`)
	const zeroQty = await req('POST', '/api/invoices', { clientId: withInvoices, status: 'draft', items: [{ description: 'x', qty: 0, unitPrice: 1 }] })
	if (zeroQty.status !== 400) fail(`qty 0 line accepted (HTTP ${zeroQty.status}), expected 400 (round 11)`)
	const negPrice = await req('POST', '/api/invoices', { clientId: withInvoices, status: 'draft', items: [{ description: 'x', qty: 1, unitPrice: -5 }] })
	if (negPrice.status !== 400) fail(`negative unitPrice accepted (HTTP ${negPrice.status}), expected 400 (round 11)`)
	if (!all.items.every((i) => Math.abs(i.total - round2(i.total)) < 1e-9)) fail('invoice totals are not rounded to 2 decimals (round 11)')
}

// Restart persistence (round 2+): a row created now must survive a full server restart.
{
	const created = await req('POST', '/api/clients', { name: 'Persistence Probe', email: 'persist@check.example' })
	if (created.status !== 201) fail(`persistence probe create → HTTP ${created.status}`)
	const id = created.json.id
	killServer()
	cookie = ''
	await bootServer()
	await login({ required: false }) // in-memory sessions die with the process — by design; re-login when a wall exists
	const back = await req('GET', `/api/clients/${id}`)
	if (back.status !== 200 || back.json?.name !== 'Persistence Probe') fail(`client ${id} did not survive a server restart — data is not in the database (round 2)`)
	await req('DELETE', `/api/clients/${id}`)
}
} catch (e) {
	if (e instanceof CheckFail) {
		/* already recorded by fail() */
	} else if (COLLECT) {
		// The r4 class (2026-08-22): the CHECK crashed, not the app. Recorded distinctly — the runner's
		// feedback path must not present an instrument fault to the model as its own defect.
		failures.push(`check instrument crashed: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
	} else {
		killServer()
		throw e
	}
}

killServer()
finish()
