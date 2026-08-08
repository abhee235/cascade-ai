// mcpRegistry.ts — the configured MCP servers (ADR-071). Web search and other capabilities are provided by
// connecting MCP servers rather than hardcoded tools.
// This is the GLOBAL, UI-managed config store — mirrors modelRegistry.ts: a single JSON file the
// management panel reads/writes, persisted so the user's servers survive restarts.
//
// Global (per install), not per-project: you configure a search MCP once, and every project's sessions get
// it. The core `.mcp.json` per-project mechanism still works underneath; this is the server's own registry
// that the web UI edits.

import type { ConfigStore } from '@cascade/storage'
import type { McpServerConfig } from '@cascade/core'

/** name → server config (stdio: command/args/env; env carries API keys, kept server-side). */
type McpServers = Record<string, McpServerConfig>

// ADR-081: persistence moved behind ConfigStore. The read API stays SYNCHRONOUS — `enabledMcpServers` is
// handed to createSession as a thunk and is called whenever a session is built, so it cannot await. This
// was already an in-memory cache over a file; only the backing store changed.
let store: ConfigStore | undefined
let cache: McpServers | null = null

/** Load the registry from the injected store (called once at server startup). */
export async function initMcpRegistry(s: ConfigStore): Promise<void> {
  store = s
  cache = Object.fromEntries((await s.connectors()).map(({ name, ...config }) => [name, config as McpServerConfig]))
}

function load(): McpServers {
  if (!cache) cache = {} // init not run (a test, or a headless embed) — no configured servers
  return cache
}

/** Persist one server, best-effort — a failed write costs persistence, never the running config. */
const persist = (name: string) => void Promise.resolve(store?.upsertConnector({ name, ...(load()[name] as object) })).catch(() => {})

/** Every configured server (enabled or not) — for the management panel. */
export function mcpServers(): McpServers {
  return { ...load() }
}

/** Only the ENABLED servers — what a session actually connects (passed to createSession). */
export function enabledMcpServers(): McpServers {
  return Object.fromEntries(Object.entries(load()).filter(([, c]) => !c.disabled))
}

/** Add OR EDIT a server. The key lives here (server-side), never sent back. Merge rule (the "leave blank to
 *  keep" workflow): if `config.apiKey` is UNDEFINED and the server already exists, KEEP its current key — so
 *  the host can be edited without re-entering the key. An empty string CLEARS it; a value SETS it. */
export function addMcpServer(name: string, config: McpServerConfig): void {
  const servers = load()
  const existing = servers[name]
  const apiKey = config.apiKey === undefined ? existing?.apiKey : config.apiKey || undefined
  servers[name] = { ...config, apiKey }
  persist(name)
}

export function removeMcpServer(name: string): void {
  const servers = load()
  if (name in servers) {
    delete servers[name]
    void Promise.resolve(store?.removeConnector(name)).catch(() => {})
  }
}

export function toggleMcpServer(name: string, disabled: boolean): void {
  const servers = load()
  if (servers[name]) {
    servers[name] = { ...servers[name], disabled }
    persist(name)
  }
}

/** Whether ANY server is configured — lets the server skip building an McpHub when there's nothing to connect. */
export function hasMcpServers(): boolean {
  // Was `existsSync(file) && …`; the file check was only ever a proxy for "anything configured?", and the
  // loaded map answers that directly now.
  return Object.keys(load()).length > 0
}
