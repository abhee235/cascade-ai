// mcp/loadMcpConfig.ts — read MCP server config from a project file, the portable, editor-agnostic way to
// configure servers (the common `.mcp.json` format). Shape: { "mcpServers": {…} }.
//
// Headless: it just reads a path the caller gives it. The extension reads <workspace>/.mcp.json; the web
// server (Phase 12) can read the same file from its project dir — same engine, same config format.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerConfig } from './mcpHub'

/** The conventional filename, at the project root. Committable (unlike VS Code settings). */
export const MCP_CONFIG_FILE = '.mcp.json'

/** Read `<cwd>/.mcp.json` and return its `mcpServers` map. Missing or invalid file ⇒ {} (a broken config
 *  file must never crash startup). */
export function loadMcpServers(cwd: string): Record<string, McpServerConfig> {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, MCP_CONFIG_FILE), 'utf8'))
    const servers = parsed?.mcpServers
    return servers && typeof servers === 'object' ? servers : {}
  } catch {
    return {}
  }
}
