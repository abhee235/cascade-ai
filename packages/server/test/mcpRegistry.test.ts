// ADR-071 — the MCP server registry: a UI-managed mcp.json, persisted, enabled/disabled filtering.
import { beforeEach, describe, expect, it } from 'vitest'
import { addMcpServer, enabledMcpServers, hasMcpServers, initMcpRegistry, mcpServers, removeMcpServer, toggleMcpServer } from '../src/mcpRegistry'

// ADR-081: the registry now persists through a ConfigStore rather than a JSON file, so the harness is an
// IN-MEMORY store. That is a better test than a temp dir was: it exercises the port the desktop and a
// hosted deployment both implement, instead of one backend's file layout.
function memoryConfig() {
  let models = []
  let connectors = []
  let active
  const settings = new Map()
  const same = (a, p, m) => a.provider === p && a.model === m
  return {
    async models() { return models.map((m) => ({ ...m })) },
    async upsertModel(m) {
      const i = models.findIndex((x) => same(x, m.provider, m.model))
      if (i >= 0) models[i] = { ...models[i], ...m }
      else models.push({ ...m })
    },
    async removeModel(p, m) { models = models.filter((x) => !same(x, p, m)) },
    async activeModel() { return active },
    async setActiveModel(a) { active = { ...a } },
    async connectors() { return connectors.map((c) => ({ ...c })) },
    async upsertConnector(c) {
      const i = connectors.findIndex((x) => x.name === c.name)
      if (i >= 0) connectors[i] = { ...connectors[i], ...c }
      else connectors.push({ ...c })
    },
    async removeConnector(name) { connectors = connectors.filter((c) => c.name !== name) },
    async setting(k) { return settings.get(k) },
    async setSetting(k, v) { settings.set(k, v) },
    /** Test seam: corrupt/replace what a reload will see. */
    _setActive(a) { active = a },
  }
}
/** Writes are fire-and-forget by design (a config write must never block a request handler), so a test
 *  that reloads has to let those microtasks settle first. */
const settled = () => new Promise((r) => setTimeout(r, 0))

let store: ReturnType<typeof memoryConfig>
beforeEach(async () => {
  store = memoryConfig()
  await initMcpRegistry(store as never)
})

describe('mcpRegistry', () => {
  it('starts empty', async () => {
    expect(mcpServers()).toEqual({})
    expect(hasMcpServers()).toBe(false)
  })

  it('adds a server (with env keys) and persists it as portable .mcp.json', async () => {
    addMcpServer('tavily', { url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=secret' })
    expect(mcpServers().tavily.url).toContain('tavily.com')
    expect(hasMcpServers()).toBe(true)
    // Persisted under the { mcpServers } shape so the file doubles as a hand-editable .mcp.json.
    await settled()
    const stored = Object.fromEntries((await store.connectors()).map(({ name, ...c }) => [name, c]))
    const onDisk = { mcpServers: stored }
    expect(onDisk.mcpServers.tavily.url).toContain('tavilyApiKey=secret')
  })

  it('survives a restart (re-init re-reads the file)', async () => {
    addMcpServer('s', { url: 'https://x.com/mcp' })
    await settled()
    await initMcpRegistry(store as never) // drop the cache, same store — like a server restart
    expect(mcpServers().s.url).toBe('https://x.com/mcp')
  })

  it('enabledMcpServers excludes disabled ones (what a session actually connects)', async () => {
    addMcpServer('on', { url: 'https://a.com' })
    addMcpServer('off', { url: 'https://b.com' })
    toggleMcpServer('off', true)
    expect(Object.keys(enabledMcpServers())).toEqual(['on']) // disabled 'off' is withheld from sessions…
    expect(Object.keys(mcpServers())).toHaveLength(2) // …but still shown in the management list
  })

  it('toggle back on re-enables', async () => {
    addMcpServer('s', { url: 'https://a.com' })
    toggleMcpServer('s', true)
    expect(enabledMcpServers()).toEqual({})
    toggleMcpServer('s', false)
    expect(Object.keys(enabledMcpServers())).toEqual(['s'])
  })

  it('remove deletes it', async () => {
    addMcpServer('s', { url: 'https://a.com' })
    removeMcpServer('s')
    expect(mcpServers()).toEqual({})
  })
})
