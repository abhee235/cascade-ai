// chatStore.ts — chats and their replay logs in SQLite (ADR-081 §2).
//
// This one retires the LAST thing tying packages/server to a single deployment. Chats used to live as
// three files under each project directory (`chats.json`, `chat-<id>.json`, `chat-<id>.events.jsonl`),
// which meant the server had to know a host path to find a conversation — the exact coupling the storage
// ports exist to remove. Keyed on projectId here, so a hosted deployment stores the same rows in Postgres
// and nothing above this file changes.
//
// Two write paths with deliberately different shapes:
//   • messages — one JSON document per chat, replaced wholesale. Reads are always "the whole conversation".
//   • events   — one ROW per entry, appended and buffered. Hundreds per turn, read as a recent slice.
//
// Every write here is best-effort in the same sense the files were: losing replay fidelity is bad, taking
// a live turn down to preserve it is worse.

import { randomBytes } from 'node:crypto'
import type { ChatRecord, ChatStore, ReplayEntry } from '@cascade/storage'
import { BufferedWriter, type Db } from './db.js'

/** Soft cap on replayed entries — a marathon chat replays its most recent slice, not an unbounded log. */
const DEFAULT_REPLAY_LIMIT = 3000

/** The title a chat carries until a first user message names it. Prune and title-derivation both key off
 *  this exact string, as the file implementation did. */
const UNTITLED = 'New chat'

interface ChatRow {
	id: string
	project_id: string
	title: string
	created_at: string
	updated_at: string
	messages: string | null
}

const toChat = (r: ChatRow): ChatRecord => ({
	id: r.id,
	projectId: r.project_id,
	title: r.title,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
})

/** Tolerant parse: a corrupt document reads as "empty", never as a crash. The file version had the same
 *  property via try/catch around JSON.parse, and it is what keeps one bad row from bricking a project. */
const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
	if (!s) return fallback
	try {
		return JSON.parse(s) as T
	} catch {
		return fallback
	}
}

export function createChatStore(db: Db): ChatStore {
	const insertChat = db.prepare('INSERT INTO chats (id, project_id, title, created_at, updated_at, messages) VALUES (?, ?, ?, ?, ?, ?)')
	const selectByProject = db.prepare('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC')
	const selectAll = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC')
	const selectOne = db.prepare('SELECT * FROM chats WHERE id = ?')
	const updateTitle = db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
	const updateMessages = db.prepare('UPDATE chats SET messages = ?, title = ?, updated_at = ? WHERE id = ?')
	const deleteChat = db.prepare('DELETE FROM chats WHERE id = ?')
	const deleteEvents = db.prepare('DELETE FROM chat_events WHERE chat_id = ?')
	const insertEvent = db.prepare('INSERT INTO chat_events (chat_id, entry) VALUES (?, ?)')
	// Newest-first with a LIMIT, then reversed in JS. Ordering ascending and slicing the tail would make
	// SQLite walk the whole log to find the end; this rides the (chat_id, seq) index backwards and stops.
	const selectEvents = db.prepare('SELECT entry FROM chat_events WHERE chat_id = ? ORDER BY seq DESC LIMIT ?')
	const countEvents = db.prepare('SELECT COUNT(*) AS c FROM chat_events WHERE chat_id = ?')

	// Same reasoning as spans: the cost is the commit, not the insert, and `append` sits on the turn's hot
	// path where it must never block. One transaction per batch.
	const writer = new BufferedWriter<{ chat_id: string; entry: string }>((rows) => {
		db.exec('BEGIN')
		try {
			for (const r of rows) insertEvent.run(r.chat_id, r.entry)
			db.exec('COMMIT')
		} catch (e) {
			db.exec('ROLLBACK')
			throw e
		}
	})

	const now = () => new Date().toISOString()
	const chatRow = (id: string) => selectOne.get(id) as unknown as ChatRow | undefined

	return {
		async list(projectId) {
			return (selectByProject.all(projectId) as unknown as ChatRow[]).map(toChat)
		},

		async listAll() {
			// One query for the Chats page. Scanning every project's directory made this O(projects) in
			// syscalls, and it showed: the page visibly stalled on an install with 46 projects.
			return (selectAll.all() as unknown as ChatRow[]).map(toChat)
		},

		async get(chatId) {
			const row = chatRow(chatId)
			return row ? toChat(row) : undefined
		},

		async create(chat) {
			const stamp = now()
			const record: ChatRecord = { ...chat, createdAt: stamp, updatedAt: stamp }
			insertChat.run(record.id, record.projectId, record.title, stamp, stamp, '[]')
			return record
		},

		async rename(chatId, title) {
			const row = chatRow(chatId)
			if (!row) return
			// An all-whitespace rename keeps the old title rather than blanking the sidebar entry.
			updateTitle.run(title.trim().slice(0, 80) || row.title, now(), chatId)
		},

		async delete(chatId) {
			writer.flush() // in-flight events for a deleted chat would otherwise resurrect it as an orphan log
			deleteEvents.run(chatId)
			deleteChat.run(chatId)
		},

		async prune(projectId, keepId) {
			writer.flush() // a running chat's events may still be buffered — see the port's note on why this matters
			const removed: string[] = []
			for (const row of selectByProject.all(projectId) as unknown as ChatRow[]) {
				if (row.id === keepId || row.title !== UNTITLED) continue
				if (parseJson<unknown[]>(row.messages, []).length) continue
				if ((countEvents.get(row.id) as unknown as { c: number }).c > 0) continue
				deleteEvents.run(row.id)
				deleteChat.run(row.id)
				removed.push(row.id)
			}
			return removed
		},

		async messages(chatId) {
			return parseJson<unknown[]>(chatRow(chatId)?.messages, [])
		},

		async saveMessages(chatId, messages, firstUserText) {
			const row = chatRow(chatId)
			if (!row) return
			// Title derivation happens HERE, in the same statement as the history, so the two cannot
			// disagree. Only an untitled chat is renamed — a user's explicit title is never overwritten.
			const title = row.title === UNTITLED && firstUserText ? firstUserText.replace(/\s+/g, ' ').trim().slice(0, 60) || row.title : row.title
			updateMessages.run(JSON.stringify(messages), title, now(), chatId)
		},

		append(chatId, entry) {
			// Deliberately synchronous and void — callers are inside the agent's event stream.
			try {
				writer.push({ chat_id: chatId, entry: JSON.stringify(entry) })
			} catch {
				/* an unserialisable entry loses replay fidelity, not the session */
			}
		},

		async replay(chatId, limit = DEFAULT_REPLAY_LIMIT) {
			writer.flush() // a reload mid-turn must see the events this turn has already produced
			const rows = selectEvents.all(chatId, limit) as unknown as { entry: string }[]
			// Read newest-first for the index, hand back oldest-first for the reducer.
			return rows
				.reverse()
				.map((r) => parseJson<ReplayEntry | null>(r.entry, null))
				.filter((e): e is ReplayEntry => e !== null)
		},

		async flush() {
			writer.flush()
		},
	}
}

/** Chat ids are 8 hex chars, matching the ids the file store minted — so imported chats keep their ids and
 *  any reference to one (a span's `cascade.chat_id`) still resolves after the migration. */
export const newChatId = () => randomBytes(4).toString('hex')
