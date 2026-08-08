// The file→SQLite chat migration (ADR-081 §2).
//
// This replaces the old packages/server/test/chatReplay.test.ts. That suite tested a file-backed store
// that no longer exists; its behavioural assertions (ordering, torn lines, prune-vs-live-turn) moved into
// the shared port conformance suite, which every adapter runs. What is NOT covered there, and is the part
// that can only go wrong once, is the migration itself — so that is what this file tests.
//
// The specific hazard: a user upgrades, and their chats either vanish, duplicate, or come back detached
// from the traces that produced them. There is no second chance to get it right on their machine.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { createChatStore } from '../src/chatStore.js'
import { importLegacyChats } from '../src/importLegacy.js'

const freshStore = () => createChatStore(openDb(join(mkdtempSync(join(tmpdir(), 'cascade-import-')), 'cascade.db')))

/** Lay out one project exactly as the file store wrote it: an index, a flattened conversation per chat,
 *  and a JSONL replay log per chat. */
function legacyProject(chats: { id: string; title: string; messages?: unknown[]; events?: unknown[]; rawEventsTail?: string }[]): string {
	const dir = mkdtempSync(join(tmpdir(), 'cascade-project-'))
	const cascade = join(dir, '.cascade')
	mkdirSync(cascade, { recursive: true })
	const stamp = '2026-07-02T11:14:26.287Z'
	writeFileSync(join(cascade, 'chats.json'), JSON.stringify(chats.map((c) => ({ id: c.id, title: c.title, createdAt: stamp, updatedAt: stamp }))))
	for (const c of chats) {
		if (c.messages) writeFileSync(join(cascade, `chat-${c.id}.json`), JSON.stringify(c.messages))
		if (c.events || c.rawEventsTail) {
			const lines = (c.events ?? []).map((e) => `${JSON.stringify(e)}\n`).join('')
			writeFileSync(join(cascade, `chat-${c.id}.events.jsonl`), lines + (c.rawEventsTail ?? ''))
		}
	}
	return dir
}

describe('importLegacyChats', () => {
	it('imports each project’s chats, PRESERVING their ids', async () => {
		// Ids must survive: spans are stamped with `cascade.chat_id`, so re-minting would sever every
		// historical trace from the conversation that produced it and blank the Observatory's Sessions view.
		const store = freshStore()
		const dirA = legacyProject([{ id: 'c8f60c38', title: 'Build "Simmer"', messages: [{ role: 'user', content: 'build a recipe app' }] }])
		const dirB = legacyProject([{ id: '6cb31ebe', title: 'A todo list' }])

		const result = await importLegacyChats(store, [
			{ id: 'project-a', dir: dirA },
			{ id: 'project-b', dir: dirB },
		])

		expect(result.chats).toBe(2)
		expect((await store.list('project-a')).map((c) => c.id)).toEqual(['c8f60c38'])
		expect((await store.list('project-b')).map((c) => c.id)).toEqual(['6cb31ebe'])
		expect((await store.get('c8f60c38'))?.title).toBe('Build "Simmer"')
		expect(await store.messages('c8f60c38')).toEqual([{ role: 'user', content: 'build a recipe app' }])
	})

	it('preserves each chat’s original dates', async () => {
		// The chat list is sorted by updatedAt and shows it as "8m ago". Importing with fresh stamps makes
		// every chat look like it was touched at upgrade time and destroys the ordering — which is exactly
		// what the first version of this migration did, invisibly to a passing test suite.
		const store = freshStore()
		const dir = legacyProject([{ id: 'c1', title: 'Build "Simmer"' }])
		await importLegacyChats(store, [{ id: 'p1', dir }])
		const chat = await store.get('c1')
		expect(chat?.createdAt).toBe('2026-07-02T11:14:26.287Z')
		expect(chat?.updatedAt).toBe('2026-07-02T11:14:26.287Z')
	})

	it('carries the replay log across in order, with its display hints intact', async () => {
		// The reason the log exists at all: a chat rebuilt from flattened rows lost thinking, diffs and tool
		// status. If the migration flattens or reorders it, that regression comes back for every old chat.
		const store = freshStore()
		const events = [
			{ user: 'Build "Simmer"' },
			{ event: { type: 'toolStart', id: 't1', name: 'Write', summary: 'Writing src/types.ts' } },
			{ event: { type: 'toolResult', id: 't1', ok: true, display: { kind: 'fileEdit', path: 'src/types.ts', op: 'create', diff: '+x' } } },
		]
		const dir = legacyProject([{ id: 'c1', title: 'Build "Simmer"', events }])

		const result = await importLegacyChats(store, [{ id: 'p1', dir }])

		expect(result.events).toBe(3)
		const replayed = await store.replay('c1')
		expect(replayed).toEqual(events)
		expect((replayed[2] as { event: { display: { kind: string } } }).event.display.kind).toBe('fileEdit')
	})

	it('skips a torn tail line from a crash mid-append, keeping the rest', async () => {
		const store = freshStore()
		const dir = legacyProject([{ id: 'c1', title: 'x', events: [{ user: 'hello' }], rawEventsTail: '{"event":{"type":"tool' }])
		await importLegacyChats(store, [{ id: 'p1', dir }])
		expect(await store.replay('c1')).toEqual([{ user: 'hello' }])
	})

	it('is idempotent — a second run does not duplicate anything', async () => {
		// The caller guards with a marker, but a project restored from a backup after the marker was set
		// would otherwise import again. Duplicated chats are worse than un-imported ones: they cannot be
		// told apart afterwards.
		const store = freshStore()
		const dir = legacyProject([{ id: 'c1', title: 'Build "Simmer"', events: [{ user: 'hi' }] }])
		await importLegacyChats(store, [{ id: 'p1', dir }])
		const second = await importLegacyChats(store, [{ id: 'p1', dir }])

		expect(second.chats).toBe(0)
		expect((await store.list('p1')).length).toBe(1)
		expect(await store.replay('c1')).toEqual([{ user: 'hi' }])
	})

	it('a project with no chats, or a missing directory, is a silent no-op', async () => {
		// A failed launch is a far worse outcome than an un-migrated chat, so every read here is defensive.
		const store = freshStore()
		const empty = mkdtempSync(join(tmpdir(), 'cascade-empty-'))
		const result = await importLegacyChats(store, [
			{ id: 'p1', dir: empty },
			{ id: 'p2', dir: join(empty, 'does-not-exist') },
		])
		expect(result).toEqual({ chats: 0, events: 0 })
	})

	it('imports a chat that has a replay log but no saved messages — a turn that never finished', async () => {
		// History is written when a turn ENDS. A build interrupted by a crash or a quit leaves events and no
		// messages, and that transcript is exactly the one someone wants back after an upgrade.
		const store = freshStore()
		const dir = legacyProject([{ id: 'c1', title: 'New chat', events: [{ user: 'Build "StyleHub"' }, { event: { type: 'toolStart' } }] }])
		await importLegacyChats(store, [{ id: 'p1', dir }])

		expect(await store.messages('c1')).toEqual([])
		expect(await store.replay('c1')).toHaveLength(2)
		// And it must survive the very next prune, which runs on project open.
		expect(await store.prune('p1')).toEqual([])
	})
})
