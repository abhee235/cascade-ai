// server/index.ts — the app's backend API (added by the backend pack). Express + Prisma over SQLite.
//
// It exposes one REST resource per Prisma model through a generic CRUD router, so adding a collection to
// the API is: (1) add the model to prisma/schema.prisma, (2) migrate, (3) add ONE line to `RESOURCES`
// below. The frontend reaches this via the Vite dev proxy (/api → :8787), so the browser only ever calls
// relative `/api/...` URLs — no CORS, no ports in the client.
//
// In production (NODE_ENV=production) this same process also serves the built frontend from dist/, so the
// whole app is ONE deployable Node process. In dev, `npm run dev` runs this alongside Vite via concurrently.

import express from 'express'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT ?? 8787)
const here = dirname(fileURLToPath(import.meta.url))

// One entry per collection you want a REST API for. `model` must match a Prisma model delegate name
// (lowercase of the schema model, e.g. model `Recipe` → prisma.recipe). Add a line when you add a model.
const RESOURCES: { path: string; model: keyof PrismaClient }[] = [
	{ path: 'notes', model: 'note' },
]

app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Generic CRUD, mounted per resource. Consistent JSON envelope; errors return { error }.
for (const { path, model } of RESOURCES) {
	const delegate = () => prisma[model] as unknown as {
		findMany: (a?: unknown) => Promise<unknown[]>
		findUnique: (a: unknown) => Promise<unknown>
		create: (a: unknown) => Promise<unknown>
		update: (a: unknown) => Promise<unknown>
		delete: (a: unknown) => Promise<unknown>
	}
	app.get(`/api/${path}`, async (_req, res) => {
		try {
			res.json(await delegate().findMany())
		} catch (e) {
			res.status(500).json({ error: String(e) })
		}
	})
	app.get(`/api/${path}/:id`, async (req, res) => {
		try {
			const row = await delegate().findUnique({ where: { id: coerceId(req.params.id) } })
			row ? res.json(row) : res.status(404).json({ error: 'not found' })
		} catch (e) {
			res.status(500).json({ error: String(e) })
		}
	})
	app.post(`/api/${path}`, async (req, res) => {
		try {
			res.status(201).json(await delegate().create({ data: req.body }))
		} catch (e) {
			res.status(400).json({ error: String(e) })
		}
	})
	app.put(`/api/${path}/:id`, async (req, res) => {
		try {
			res.json(await delegate().update({ where: { id: coerceId(req.params.id) }, data: req.body }))
		} catch (e) {
			res.status(400).json({ error: String(e) })
		}
	})
	app.delete(`/api/${path}/:id`, async (req, res) => {
		try {
			await delegate().delete({ where: { id: coerceId(req.params.id) } })
			res.status(204).end()
		} catch (e) {
			res.status(400).json({ error: String(e) })
		}
	})
}

// Ids may be numeric (autoincrement) or string (cuid) depending on the model — coerce numeric strings.
function coerceId(raw: string): string | number {
	return /^\d+$/.test(raw) ? Number(raw) : raw
}

// Production: serve the built SPA from dist/ so one process = the whole app. (Dev serves via Vite.)
if (process.env.NODE_ENV === 'production') {
	const dist = join(here, '..', 'dist')
	if (existsSync(dist)) {
		app.use(express.static(dist))
		app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html'))) // SPA fallback
	}
}

app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`))
