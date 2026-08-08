// importLegacy.ts — bring an existing install's JSON config into the DB, once (ADR-081 §2).
//
// This lives in the ADAPTER, not the server, and that is the point: "how do I get from the old on-disk
// format to my format" is knowledge about THIS backend. A Postgres adapter would have its own answer (or
// none). The server just receives a ConfigStore that already has the user's models in it.
//
// Runs ONCE, recorded by a marker setting. The first version guarded on "is the store empty?", which is
// a different question: delete every model and the store is empty again, so the next launch would import
// them back — the app appearing to ignore you. Caught by a test, and worth the extra key.
//
// The legacy files are LEFT in place. Deleting a user's config the first time a new build starts is not a
// migration, it is a gamble, and keeping them costs a few KB.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatStore, ConfigStore, ConnectorRecord, ModelRecord, ReplayEntry } from '@cascade/storage'

/** Set once the import has been considered — see the note above on why emptiness is not the test. */
const MARKER = 'legacyConfigImported'
/** The same discipline for chats, tracked separately: the two migrations landed in different releases, so
 *  an install can legitimately have done one and not the other. */
const CHATS_MARKER = 'legacyChatsImported'

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined // absent or unreadable — a fresh install, which is the common case
  }
}

/**
 * @param legacyDir the old `<projectsRoot>/.cascade` directory
 * @returns what was imported, for the boot log — silence about a migration is how you find out it
 *          didn't run three weeks later
 */
export async function importLegacyConfig(store: ConfigStore, legacyDir: string): Promise<{ models: number; connectors: number; active: boolean }> {
  const imported = { models: 0, connectors: 0, active: false }
  if (await store.setting(MARKER)) return imported
  // Config already present without the marker: an install that was configured after the move but before
  // this guard existed. Mark it and leave it alone — merging into a live config could resurrect deletions.
  if ((await store.models()).length || (await store.connectors()).length || (await store.activeModel())) {
    await store.setSetting(MARKER, true)
    return imported
  }

  for (const m of readJson<ModelRecord[]>(join(legacyDir, 'models.json')) ?? []) {
    if (m?.provider && m?.model) {
      await store.upsertModel(m)
      imported.models++
    }
  }

  const active = readJson<{ provider: string; model: string; baseUrl?: string }>(join(legacyDir, 'active-model.json'))
  if (active?.provider && active?.model) {
    await store.setActiveModel(active)
    imported.active = true
  }

  // The legacy file is either { mcpServers: {…} } (the portable .mcp.json shape) or a bare map.
  const raw = readJson<Record<string, unknown>>(join(legacyDir, 'mcp.json'))
  const servers = (raw?.mcpServers ?? raw) as Record<string, Omit<ConnectorRecord, 'name'>> | undefined
  for (const [name, config] of Object.entries(servers ?? {})) {
    if (config && typeof config === 'object') {
      await store.upsertConnector({ name, ...config })
      imported.connectors++
    }
  }
  await store.setSetting(MARKER, true)
  return imported
}

/** One chat as the file store wrote it into `chats.json`. */
type LegacyChatMeta = { id: string; title: string; createdAt: string; updatedAt: string }

/**
 * Bring each project's file-backed chats into the DB, once.
 *
 * The files lived under the PROJECT directory (`<dir>/.cascade/chats.json`, `chat-<id>.json`,
 * `chat-<id>.events.jsonl`), which is why the server had to know a host path to find a conversation. Ids
 * are PRESERVED rather than re-minted: spans are stamped with `cascade.chat_id`, so a new id would sever
 * every existing trace from the conversation that produced it — the Observatory's Sessions view would go
 * blank for all historical work.
 *
 * @param projects the id↔dir pairs from the projects index — the mapping the adapter cannot derive itself
 * @returns counts for the boot log; silence about a migration is how you discover it never ran
 */
export async function importLegacyChats(store: ChatStore, projects: { id: string; dir: string }[]): Promise<{ chats: number; events: number }> {
	// The "run once" marker lives in the CONFIG store (see chatsImported/markChatsImported below) because
	// ChatStore has no settings surface — the caller checks it, so this stays a pure importer.
	const imported = { chats: 0, events: 0 }
	for (const project of projects) {
		const legacyDir = join(project.dir, '.cascade')
		for (const meta of readJson<LegacyChatMeta[]>(join(legacyDir, 'chats.json')) ?? []) {
			if (!meta?.id) continue
			// Skip anything already present: this runs behind a marker, but a project restored from a backup
			// after the marker was set would otherwise duplicate its chats.
			if (await store.get(meta.id)) continue
			// ONE call, carrying the original timestamps and history. Creating and then saving would stamp
			// `updatedAt` twice with "now", collapsing a user's whole chat history into a single block dated
			// at the moment they upgraded — and that field is what the list is sorted by and displays.
			await store.create({
				id: meta.id,
				projectId: project.id,
				title: meta.title || 'New chat',
				createdAt: meta.createdAt,
				updatedAt: meta.updatedAt ?? meta.createdAt,
				messages: readJson<unknown[]>(join(legacyDir, `chat-${meta.id}.json`)) ?? [],
			})
			imported.chats++

			for (const entry of readJsonl(join(legacyDir, `chat-${meta.id}.events.jsonl`))) {
				store.append(meta.id, entry)
				imported.events++
			}
		}
	}
	await store.flush() // append() is fire-and-forget; the import must not return before the rows land
	return imported
}

/** Read a JSONL replay log, skipping torn lines. A crash mid-append leaves a partial last line, and losing
 *  one event is not a reason to lose the transcript. */
function readJsonl(file: string): ReplayEntry[] {
	let text: string
	try {
		text = readFileSync(file, 'utf8')
	} catch {
		return [] // pre-log chat — the caller falls back to the flattened messages
	}
	const out: ReplayEntry[] = []
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		try {
			out.push(JSON.parse(line) as ReplayEntry)
		} catch {
			/* torn tail line */
		}
	}
	return out
}

/** Has the chat import already run? Kept beside the import so the marker's name has ONE definition. */
export const chatsImported = (config: ConfigStore) => config.setting<boolean>(CHATS_MARKER)
export const markChatsImported = (config: ConfigStore) => config.setSetting(CHATS_MARKER, true)
