// The disappearing-picker regression (measured on the desktop, 2026-08-08).
//
// The seed DEFAULTS used to live only in memory, shown while the store was EMPTY and never written back.
// The first time the user touched any single model, that one row was persisted — so on the next launch
// `persisted.length` was 1, the seeding branch was skipped, and every other model in the picker vanished.
// "Only the selected model survives a restart" was the exact report.

import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore, openDb } from '@cascade/storage-sqlite'
import { addEnabledModel, enabledModels, initModelRegistry, removeEnabledModel } from '../src/modelRegistry'

const freshStore = () => createConfigStore(openDb(join(mkdtempSync(join(tmpdir(), 'cascade-seed-')), 'x.db')))
const settle = () => new Promise((r) => setTimeout(r, 50)) // registry writes are fire-and-forget

describe('model registry seeding', () => {
	it('selecting ONE model must not make the others vanish on the next boot', async () => {
		const store = freshStore()
		await initModelRegistry(store) // first boot: seeds visible
		const seeded = enabledModels().length
		expect(seeded).toBeGreaterThan(1)

		addEnabledModel('openai', 'gpt-6-luna') // the user touches one (seeded) model
		await settle()

		await initModelRegistry(store) // "restart"
		expect(enabledModels().length).toBe(seeded) // NOT 1 — the old behaviour
	})

	it('deleting a seeded model STAYS deleted across restarts', async () => {
		// The counter-concern the old design protected: a default must not resurrect after removal. The
		// marker keeps that property — seeds are written once, ever.
		const store = freshStore()
		await initModelRegistry(store)
		const first = enabledModels()[0]
		removeEnabledModel(first.provider, first.model)
		await settle()

		await initModelRegistry(store)
		expect(enabledModels().some((m) => m.provider === first.provider && m.model === first.model)).toBe(false)
	})

	it('deleting EVERY model leaves an empty picker, not a re-seeded one', async () => {
		const store = freshStore()
		await initModelRegistry(store)
		for (const m of [...enabledModels()]) removeEnabledModel(m.provider, m.model)
		await settle()

		await initModelRegistry(store)
		expect(enabledModels().length).toBe(0)
	})
})
