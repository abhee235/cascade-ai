// mcpRegistry.ts — the configured MCP servers (ADR-071). Web search and other capabilities are provided by
// connecting MCP servers rather than hardcoded tools.
// This is the GLOBAL, UI-managed config store — mirrors modelRegistry.ts: a single JSON file the
// management panel reads/writes, persisted so the user's servers survive restarts.
//
// Global (per install), not per-project: you configure a search MCP once, and every project's sessions get
// it. The core `.mcp.json` per-project mechanism still works underneath; this is the server's own registry
// that the web UI edits.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpServerConfig } from '@cascade/core'

/** name → server config (stdio: command/args/env; env carries API keys, kept server-side). */
type McpServers = Record<string, McpServerConfig>

let filePath = ''
let cache: McpServers | null = null

/** Point the registry at a project-root-adjacent file (called once at server startup). */
export function initMcpRegistry(rootDir: string): void {
  filePath = join(rootDir, '.cascade', 'mcp.json')
  cache = null
}

function load(): McpServers {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    // Accept either { mcpServers: {…} } (the portable .mcp.json shape) or a bare map, for forward-compat.
    cache = (parsed?.mcpServers ?? parsed) as McpServers
    if (!cache || typeof cache !== 'object') cache = {}
  } catch {
    cache = {}
  }
  return cache
}

function save(): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    // Write the portable { mcpServers } shape so the file doubles as a hand-editable .mcp.json.
    writeFileSync(filePath, JSON.stringify({ mcpServers: cache ?? {} }, null, 2))
  } catch {
    /* read-only fs just loses persistence, not the running config */
  }
}

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
  save()
}

export function removeMcpServer(name: string): void {
  const servers = load()
  if (name in servers) {
    delete servers[name]
    save()
  }
}

export function toggleMcpServer(name: string, disabled: boolean): void {
  const servers = load()
  if (servers[name]) {
    servers[name] = { ...servers[name], disabled }
    save()
  }
}

/** Whether ANY server is configured — lets the server skip building an McpHub when there's nothing to connect. */
export function hasMcpServers(): boolean {
  return existsSync(filePath) && Object.keys(load()).length > 0
}
