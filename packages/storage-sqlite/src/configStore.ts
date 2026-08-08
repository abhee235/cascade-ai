// configStore.ts — models, connectors and settings in SQLite (ADR-081 §2).
//
// These were three JSON files written with writeFileSync. That is fine until it isn't: a crash mid-write
// leaves half a file, and half a `models.json` is a picker that has lost your models. A transaction
// cannot do that.
//
// Stored as DOCUMENTS (one JSON value per key) rather than a table per concept, deliberately. Nothing
// queries these — every read is "give me all the models" or "give me all the connectors", the sets are
// tens of rows, and the shapes still change as ADR-067/076/077 evolve. A document keeps the migration
// from the JSON files to a copy, and keeps a shape change from being a schema change.

import type { ConfigStore, ConnectorRecord, ModelRecord } from '@cascade/storage'
import type { Db } from './db.js'

type ActiveModel = { provider: string; model: string; baseUrl?: string }

const MODELS = 'models'
const ACTIVE = 'activeModel'
const CONNECTORS = 'connectors'

export function createConfigStore(db: Db): ConfigStore {
  const get = db.prepare('SELECT value FROM config WHERE key = ?')
  const put = db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

  const read = <T>(key: string): T | undefined => {
    const row = get.get(key) as { value: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      // A corrupt value must not take the app down — it reads as "unset", which is recoverable.
      return undefined
    }
  }
  const write = (key: string, value: unknown) => put.run(key, JSON.stringify(value))

  const models = () => read<ModelRecord[]>(MODELS) ?? []
  const connectors = () => read<ConnectorRecord[]>(CONNECTORS) ?? []
  const sameModel = (a: ModelRecord, provider: string, model: string) => a.provider === provider && a.model === model

  return {
    async models() {
      return models()
    },
    async upsertModel(m) {
      const list = models()
      const i = list.findIndex((x) => sameModel(x, m.provider, m.model))
      // MERGE, never replace: the editor sends only the fields it changed, and a naive overwrite would
      // silently drop the endpoint's stored key when someone edits the context window.
      if (i >= 0) list[i] = { ...list[i], ...m, apiKey: m.apiKey ?? list[i].apiKey }
      else list.push(m)
      write(MODELS, list)
    },
    async removeModel(provider, model) {
      write(MODELS, models().filter((m) => !sameModel(m, provider, model)))
    },
    async activeModel() {
      return read<ActiveModel>(ACTIVE)
    },
    async setActiveModel(m) {
      write(ACTIVE, m)
    },

    async connectors() {
      return connectors()
    },
    async upsertConnector(c) {
      const list = connectors()
      const i = list.findIndex((x) => x.name === c.name)
      // The documented merge rule (ADR-071): `apiKey` UNDEFINED keeps the stored key — that is what makes
      // "change the host without re-entering the key" work — '' clears it, a string replaces it.
      if (i >= 0) list[i] = { ...list[i], ...c, apiKey: c.apiKey === undefined ? list[i].apiKey : c.apiKey || undefined }
      else list.push(c)
      write(CONNECTORS, list)
    },
    async removeConnector(name) {
      write(CONNECTORS, connectors().filter((c) => c.name !== name))
    },

    async setting<T>(key: string) {
      return read<T>(`setting:${key}`)
    },
    async setSetting(key, value) {
      write(`setting:${key}`, value)
    },
  }
}
