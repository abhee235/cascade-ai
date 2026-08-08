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
import type { ConfigStore, ConnectorRecord, ModelRecord } from '@cascade/storage'

/** Set once the import has been considered — see the note above on why emptiness is not the test. */
const MARKER = 'legacyConfigImported'

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
