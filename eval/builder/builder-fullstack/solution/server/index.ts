// server/index.ts — Studio Manager's backend (backend pack, extended round by round).
// Express + Prisma over SQLite. Auth wall (scrypt + in-memory sid sessions), {items,total} envelopes with
// search/filter/pagination, server-computed invoice totals, /api/stats aggregates, CSV export, and the
// hardening rules (409 on deleting an invoiced client; 2-decimal money; line-item validation).

import express from 'express'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT ?? 8787)
const here = dirname(fileURLToPath(import.meta.url))
const round2 = (n: number) => Math.round(n * 100) / 100

// ── Auth (round 9): scrypt hashes, in-memory sessions, an HttpOnly sid cookie ───────────────────────────
const sessions = new Map<string, { userId: number; email: string }>()

const hashPassword = (password: string): string => {
	const salt = randomBytes(16).toString('hex')
	return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}
const verifyPassword = (password: string, stored: string): boolean => {
	const [salt, hash] = stored.split(':')
	if (!salt || !hash) return false
	const candidate = scryptSync(password, salt, 64)
	const expected = Buffer.from(hash, 'hex')
	return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
const readSid = (req: express.Request): string | undefined =>
	req.headers.cookie
		?.split(';')
		.map((c) => c.trim())
		.find((c) => c.startsWith('sid='))
		?.slice(4)
const setSession = (res: express.Response, userId: number, email: string): void => {
	const token = randomBytes(24).toString('hex')
	sessions.set(token, { userId, email })
	res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax`)
}

// The wall: every /api/* except auth + health requires a live session (round 9).
app.use('/api', (req, res, next) => {
	if (req.path === '/health' || req.path.startsWith('/auth/')) return next()
	const sid = readSid(req)
	if (!sid || !sessions.has(sid)) return res.status(401).json({ error: 'sign in required' })
	next()
})

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.post('/api/auth/register', async (req, res) => {
	const { email, password } = req.body ?? {}
	if (typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'a valid email is required' })
	if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' })
	if (await prisma.user.findUnique({ where: { email } })) return res.status(400).json({ error: 'that email is already registered' })
	const user = await prisma.user.create({ data: { email, passwordHash: hashPassword(password) } })
	setSession(res, user.id, user.email)
	res.status(201).json({ email: user.email })
})

app.post('/api/auth/login', async (req, res) => {
	const { email, password } = req.body ?? {}
	const user = typeof email === 'string' ? await prisma.user.findUnique({ where: { email } }) : null
	if (!user || typeof password !== 'string' || !verifyPassword(password, user.passwordHash)) {
		return res.status(401).json({ error: 'wrong email or password' })
	}
	setSession(res, user.id, user.email)
	res.json({ email: user.email })
})

app.post('/api/auth/logout', (req, res) => {
	const sid = readSid(req)
	if (sid) sessions.delete(sid)
	res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0')
	res.json({ ok: true })
})

app.get('/api/auth/me', (req, res) => {
	const sid = readSid(req)
	const session = sid ? sessions.get(sid) : undefined
	session ? res.json({ email: session.email }) : res.status(401).json({ error: 'not signed in' })
})

// ── Clients: envelope + search + pagination; 400 validation; 409 when invoiced (round 11) ───────────────
const pageParams = (req: express.Request): { skip: number; take: number } => {
	const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 50)
	const page = Math.max(Number(req.query.page) || 1, 1)
	return { skip: (page - 1) * perPage, take: perPage }
}
const validClient = (body: unknown): string | null => {
	const b = body as { name?: unknown; email?: unknown }
	if (typeof b?.name !== 'string' || b.name.trim() === '') return 'name is required'
	if (typeof b?.email !== 'string' || b.email.trim() === '') return 'email is required'
	return null
}

app.get('/api/clients', async (req, res) => {
	// SQLite Prisma has no case-insensitive `contains` mode — filter in JS (client counts stay tiny here).
	const q = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : ''
	const all = await prisma.client.findMany({ orderBy: { createdAt: 'desc' } })
	const filtered = q ? all.filter((c) => [c.name, c.email, c.company ?? ''].some((v) => v.toLowerCase().includes(q))) : all
	const { skip, take } = pageParams(req)
	res.json({ items: filtered.slice(skip, skip + take), total: filtered.length })
})
app.get('/api/clients/:id', async (req, res) => {
	const row = await prisma.client.findUnique({ where: { id: Number(req.params.id) } })
	row ? res.json(row) : res.status(404).json({ error: 'not found' })
})
app.post('/api/clients', async (req, res) => {
	const bad = validClient(req.body)
	if (bad) return res.status(400).json({ error: bad })
	const { name, email, company } = req.body
	res.status(201).json(await prisma.client.create({ data: { name: name.trim(), email: email.trim(), company: company || null } }))
})
app.put('/api/clients/:id', async (req, res) => {
	const bad = validClient(req.body)
	if (bad) return res.status(400).json({ error: bad })
	const id = Number(req.params.id)
	if (!(await prisma.client.findUnique({ where: { id } }))) return res.status(404).json({ error: 'not found' })
	const { name, email, company } = req.body
	res.json(await prisma.client.update({ where: { id }, data: { name: name.trim(), email: email.trim(), company: company || null } }))
})
app.delete('/api/clients/:id', async (req, res) => {
	const id = Number(req.params.id)
	if (!(await prisma.client.findUnique({ where: { id } }))) return res.status(404).json({ error: 'not found' })
	const invoices = await prisma.invoice.count({ where: { clientId: id } })
	if (invoices > 0) return res.status(409).json({ error: `client still has ${invoices} invoice${invoices === 1 ? '' : 's'} — delete or reassign them first` })
	await prisma.client.delete({ where: { id } })
	res.status(204).end()
})

// ── Invoices: nested items, server-computed totals, status/client filters, validation ──────────────────
type InvoiceWith = Awaited<ReturnType<typeof loadInvoices>>[number]
const loadInvoices = (where: object) => prisma.invoice.findMany({ where, include: { items: true, client: true }, orderBy: { createdAt: 'desc' } })
const invoiceOut = (inv: InvoiceWith) => ({
	id: inv.id,
	clientId: inv.clientId,
	clientName: inv.client.name,
	status: inv.status,
	createdAt: inv.createdAt,
	items: inv.items.map((i) => ({ id: i.id, description: i.description, qty: i.qty, unitPrice: round2(i.unitPrice) })),
	total: round2(inv.items.reduce((s, i) => s + i.qty * i.unitPrice, 0)),
})
const validItems = (items: unknown): string | null => {
	if (!Array.isArray(items) || items.length === 0) return 'an invoice needs at least one line item'
	for (const it of items as { description?: unknown; qty?: unknown; unitPrice?: unknown }[]) {
		if (typeof it?.description !== 'string' || it.description.trim() === '') return 'every line needs a description'
		if (typeof it?.qty !== 'number' || !Number.isInteger(it.qty) || it.qty < 1) return 'qty must be a whole number of at least 1'
		if (typeof it?.unitPrice !== 'number' || Number.isNaN(it.unitPrice) || it.unitPrice < 0) return 'unit price must be a number of at least 0'
	}
	return null
}
const STATUSES = new Set(['draft', 'sent', 'paid'])

app.get('/api/invoices', async (req, res) => {
	const where: { status?: string; clientId?: number } = {}
	if (typeof req.query.status === 'string' && STATUSES.has(req.query.status)) where.status = req.query.status
	if (req.query.clientId) where.clientId = Number(req.query.clientId)
	const all = (await loadInvoices(where)).map(invoiceOut)
	const { skip, take } = pageParams(req)
	res.json({ items: all.slice(skip, skip + take), total: all.length })
})
app.get('/api/invoices/export.csv', async (req, res) => {
	const where: { status?: string } = {}
	if (typeof req.query.status === 'string' && STATUSES.has(req.query.status)) where.status = req.query.status
	const rows = (await loadInvoices(where)).map(invoiceOut)
	const csvCell = (v: string) => (v.includes(',') || v.includes('"') ? `"${v.replaceAll('"', '""')}"` : v)
	const lines = ['id,client,status,total,date', ...rows.map((r) => `${r.id},${csvCell(r.clientName)},${r.status},${r.total.toFixed(2)},${new Date(r.createdAt).toISOString().slice(0, 10)}`)]
	res.setHeader('Content-Type', 'text/csv')
	res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"')
	res.send(lines.join('\n'))
})
app.get('/api/invoices/:id', async (req, res) => {
	const rows = await loadInvoices({ id: Number(req.params.id) })
	rows[0] ? res.json(invoiceOut(rows[0])) : res.status(404).json({ error: 'not found' })
})
app.post('/api/invoices', async (req, res) => {
	const { clientId, status, items } = req.body ?? {}
	if (!(await prisma.client.findUnique({ where: { id: Number(clientId) || 0 } }))) return res.status(400).json({ error: 'unknown client' })
	if (typeof status !== 'string' || !STATUSES.has(status)) return res.status(400).json({ error: "status must be 'draft', 'sent' or 'paid'" })
	const bad = validItems(items)
	if (bad) return res.status(400).json({ error: bad })
	const created = await prisma.invoice.create({
		data: { clientId: Number(clientId), status, items: { create: items.map((i: { description: string; qty: number; unitPrice: number }) => ({ description: i.description.trim(), qty: i.qty, unitPrice: round2(i.unitPrice) })) } },
	})
	const rows = await loadInvoices({ id: created.id })
	res.status(201).json(invoiceOut(rows[0]))
})
app.put('/api/invoices/:id', async (req, res) => {
	const id = Number(req.params.id)
	if (!(await prisma.invoice.findUnique({ where: { id } }))) return res.status(404).json({ error: 'not found' })
	const { status, items } = req.body ?? {}
	if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) return res.status(400).json({ error: "status must be 'draft', 'sent' or 'paid'" })
	if (items !== undefined) {
		const bad = validItems(items)
		if (bad) return res.status(400).json({ error: bad })
		await prisma.invoiceItem.deleteMany({ where: { invoiceId: id } })
		await prisma.invoiceItem.createMany({ data: items.map((i: { description: string; qty: number; unitPrice: number }) => ({ invoiceId: id, description: i.description.trim(), qty: i.qty, unitPrice: round2(i.unitPrice) })) })
	}
	if (status !== undefined) await prisma.invoice.update({ where: { id }, data: { status } })
	const rows = await loadInvoices({ id })
	res.json(invoiceOut(rows[0]))
})
app.delete('/api/invoices/:id', async (req, res) => {
	const id = Number(req.params.id)
	if (!(await prisma.invoice.findUnique({ where: { id } }))) return res.status(404).json({ error: 'not found' })
	await prisma.invoiceItem.deleteMany({ where: { invoiceId: id } })
	await prisma.invoice.delete({ where: { id } })
	res.status(204).end()
})

// ── Stats (round 8): counts, outstanding/paid, revenue by month for the last 6 calendar months ─────────
app.get('/api/stats', async (_req, res) => {
	const invoices = (await loadInvoices({})).map(invoiceOut)
	const sum = (status: string) => round2(invoices.filter((i) => i.status === status).reduce((s, i) => s + i.total, 0))
	const months: { month: string; total: number }[] = []
	const now = new Date()
	for (let k = 5; k >= 0; k--) {
		const d = new Date(now.getFullYear(), now.getMonth() - k, 1)
		months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, total: 0 })
	}
	for (const inv of invoices) {
		if (inv.status === 'draft') continue
		const d = new Date(inv.createdAt)
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
		const slot = months.find((m) => m.month === key)
		if (slot) slot.total = round2(slot.total + inv.total)
	}
	res.json({ clients: await prisma.client.count(), invoices: invoices.length, outstandingTotal: sum('sent'), paidTotal: sum('paid'), revenueByMonth: months })
})

// ── Seeding: deterministic first-boot data (each table seeds independently when empty) ─────────────────
async function seed(): Promise<void> {
	if ((await prisma.client.count()) === 0) {
		await prisma.client.createMany({
			data: [
				{ name: 'Aurora Textiles', email: 'hello@auroratextiles.example', company: 'Aurora Textiles Ltd' },
				{ name: 'Beacon Coffee', email: 'ops@beaconcoffee.example', company: 'Beacon Coffee Co' },
				{ name: 'Cedar & Co', email: 'studio@cedarco.example', company: 'Cedar & Co' },
				{ name: 'Driftline Surf', email: 'team@driftline.example', company: 'Driftline Surf' },
				{ name: 'Ember Bakery', email: 'orders@emberbakery.example', company: 'Ember Bakery' },
				{ name: 'Fjord Analytics', email: 'contact@fjord.example', company: 'Fjord Analytics' },
			],
		})
	}
	if ((await prisma.invoice.count()) === 0) {
		const clients = await prisma.client.findMany({ orderBy: { id: 'asc' } })
		const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
		const plan: { status: string; days: number; items: { description: string; qty: number; unitPrice: number }[] }[] = [
			{ status: 'draft', days: 3, items: [{ description: 'Brand refresh — discovery', qty: 1, unitPrice: 1200 }] },
			{ status: 'draft', days: 9, items: [{ description: 'Packaging concepts', qty: 3, unitPrice: 450.5 }] },
			{ status: 'draft', days: 15, items: [{ description: 'Site wireframes', qty: 2, unitPrice: 680.25 }, { description: 'Copy review', qty: 1, unitPrice: 220 }] },
			{ status: 'sent', days: 22, items: [{ description: 'Logo suite', qty: 1, unitPrice: 2400 }] },
			{ status: 'sent', days: 34, items: [{ description: 'Social templates', qty: 8, unitPrice: 95.75 }] },
			{ status: 'sent', days: 47, items: [{ description: 'Menu redesign', qty: 1, unitPrice: 860 }, { description: 'Print handoff', qty: 1, unitPrice: 140.4 }] },
			{ status: 'paid', days: 55, items: [{ description: 'Launch site build', qty: 1, unitPrice: 5200 }] },
			{ status: 'paid', days: 68, items: [{ description: 'Photography direction', qty: 2, unitPrice: 725 }] },
			{ status: 'paid', days: 80, items: [{ description: 'Retainer — design ops', qty: 4, unitPrice: 375.25 }] },
		]
		for (let i = 0; i < plan.length; i++) {
			const p = plan[i]
			await prisma.invoice.create({ data: { clientId: clients[i % clients.length].id, status: p.status, createdAt: daysAgo(p.days), items: { create: p.items } } })
		}
	}
	if ((await prisma.user.count()) === 0) {
		await prisma.user.create({ data: { email: 'owner@studio.local', passwordHash: hashPassword('studio123') } })
	}
}

// Production: the same process serves the built frontend (the pack's single-deployable rule).
const dist = join(here, '..', 'dist')
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
	app.use(express.static(dist))
	app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')))
}

seed().then(() => {
	app.listen(PORT, () => console.log(`Studio Manager API on :${PORT}`))
})
