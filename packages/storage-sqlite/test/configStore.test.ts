// The SQLite ConfigStore + the one-time import of an install's existing JSON config (ADR-081 §2).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createConfigStore } from '../src/configStore.js'
import { importLegacyConfig } from '../src/importLegacy.js'

const store = () => createConfigStore(openDb(join(mkdtempSync(join(tmpdir(), 'cascade-cfg-')), 'x.db')))

describe('sqlite ConfigStore (ADR-081)', () => {
  it('round-trips models, the active selection and settings', async () => {
    const s = store()
    await s.upsertModel({ provider: 'ollama', model: 'qwen', contextWindow: 32768 })
    await s.setActiveModel({ provider: 'ollama', model: 'qwen' })
    await s.setSetting('runtimeMode', 'host')
    expect(await s.models()).toEqual([{ provider: 'ollama', model: 'qwen', contextWindow: 32768 }])
    expect(await s.activeModel()).toEqual({ provider: 'ollama', model: 'qwen' })
    expect(await s.setting('runtimeMode')).toBe('host')
  })

  it('MERGES a model rather than replacing it — an edit sends only what changed', async () => {
    // The editor sends the field you touched. A naive overwrite would drop the endpoint's stored key the
    // moment someone adjusts a context window, and the model would silently stop authenticating.
    const s = store()
    await s.upsertModel({ provider: 'x', model: 'm', baseUrl: 'https://box', apiKey: 'secret', temperature: 0.4 })
    await s.upsertModel({ provider: 'x', model: 'm', contextWindow: 8192 })
    expect(await s.models()).toEqual([{ provider: 'x', model: 'm', baseUrl: 'https://box', apiKey: 'secret', temperature: 0.4, contextWindow: 8192 }])
  })

  it('honours the connector key rule: omitted keeps, empty clears, a value replaces', async () => {
    // ADR-071's "leave blank to keep" workflow — what lets you change a host without re-entering the key.
    const s = store()
    await s.upsertConnector({ name: 'tavily', url: 'https://a', apiKey: 'k1' })
    await s.upsertConnector({ name: 'tavily', url: 'https://b' }) // omitted ⇒ keep
    expect((await s.connectors())[0]).toEqual({ name: 'tavily', url: 'https://b', apiKey: 'k1' })
    await s.upsertConnector({ name: 'tavily', apiKey: 'k2' }) // a value ⇒ replace
    expect((await s.connectors())[0].apiKey).toBe('k2')
    await s.upsertConnector({ name: 'tavily', apiKey: '' }) // '' ⇒ clear
    expect((await s.connectors())[0].apiKey).toBeUndefined()
  })

  it('removes models and connectors', async () => {
    const s = store()
    await s.upsertModel({ provider: 'a', model: 'm' })
    await s.upsertConnector({ name: 'c' })
    await s.removeModel('a', 'm')
    await s.removeConnector('c')
    expect(await s.models()).toEqual([])
    expect(await s.connectors()).toEqual([])
  })

  it('survives a corrupt value rather than taking the app down', async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'cascade-cfg-')), 'x.db'))
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('models', '{ not json')
    expect(await createConfigStore(db).models()).toEqual([])
  })
})

describe('importing an existing install (ADR-081 §2)', () => {
  const legacy = (files: Record<string, unknown>) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cascade-legacy-')), '.cascade')
    mkdirSync(dir, { recursive: true })
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value))
    return dir
  }

  it('brings models, the active selection and connectors across', async () => {
    const s = store()
    const dir = legacy({
      'models.json': [{ provider: 'ollama', model: 'qwen', contextWindow: 131072, apiKey: 'k' }],
      'active-model.json': { provider: 'ollama', model: 'qwen' },
      'mcp.json': { mcpServers: { tavily: { url: 'https://mcp.tavily.com/mcp/', apiKey: 'tk' } } },
    })
    expect(await importLegacyConfig(s, dir)).toEqual({ models: 1, connectors: 1, active: true })
    expect((await s.models())[0].apiKey).toBe('k') // the key comes across, or the endpoint stops working
    expect((await s.connectors())[0]).toEqual({ name: 'tavily', url: 'https://mcp.tavily.com/mcp/', apiKey: 'tk' })
    expect(await s.activeModel()).toEqual({ provider: 'ollama', model: 'qwen' })
  })

  it('accepts a BARE mcp map as well as the portable { mcpServers } shape', async () => {
    const s = store()
    const dir = legacy({ 'mcp.json': { context7: { url: 'https://mcp.context7.com/mcp' } } })
    expect((await importLegacyConfig(s, dir)).connectors).toBe(1)
  })

  it('runs ONCE — a second launch must not resurrect what you deleted', async () => {
    // Without this guard, deleting a model would bring it back on the next restart, which reads as the
    // app ignoring you.
    const s = store()
    const dir = legacy({ 'models.json': [{ provider: 'a', model: 'm' }] })
    await importLegacyConfig(s, dir)
    await s.removeModel('a', 'm')
    expect(await importLegacyConfig(s, dir)).toEqual({ models: 0, connectors: 0, active: false })
    expect(await s.models()).toEqual([])
  })

  it('a fresh install with no legacy files is a silent no-op', async () => {
    expect(await importLegacyConfig(store(), join(tmpdir(), 'does-not-exist', '.cascade'))).toEqual({ models: 0, connectors: 0, active: false })
  })

  it('skips malformed entries instead of failing the whole import', async () => {
    const s = store()
    const dir = legacy({ 'models.json': [{ provider: 'a', model: 'm' }, { model: 'no-provider' }, null] })
    expect((await importLegacyConfig(s, dir)).models).toBe(1)
  })
})
