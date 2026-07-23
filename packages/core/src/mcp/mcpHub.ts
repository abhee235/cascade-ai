// mcp/mcpHub.ts — manage MCP servers: connect in the BACKGROUND at startup, discover tools, retry on
// failure. — ADR-014.
//
// Why background (not lazy-on-first-call): you can't advertise an MCP tool without its inputSchema, which
// only comes from a live `tools/list`. So we connect to discover — but in the background so startup never
// blocks — and retry a failed server lazily. See docs/learnings/mcp-init-strategy.md.

import type { Tool, ToolResult } from '../tools/Tool'

export interface McpServerConfig {
  /** HTTP (streamable) transport — the SAFE transport for a HOSTED server: no subprocess, just HTTP to a
   *  remote MCP. The CLEAN endpoint, with NO secret in it (e.g. https://mcp.tavily.com/mcp/). Preferred; the
   *  only kind the web UI offers. */
  url?: string
  /** The API key, stored SEPARATELY from the url so it can be rotated / the host changed independently, and
   *  so the endpoint can be shown to the client for editing without leaking the secret. Applied at connect
   *  per `apiKeyIn`. Server-side only. */
  apiKey?: string
  /** How to apply `apiKey`: `query:<param>` (e.g. `query:tavilyApiKey`), `header:<name>`, or `bearer`
   *  (Authorization: Bearer …). */
  apiKeyIn?: string
  /** Extra static auth headers for the HTTP transport (custom connectors). */
  headers?: Record<string, string>
  /** STDIO transport — spawns a SUBPROCESS. That is arbitrary code execution on the host, so it is LOCAL /
   *  trusted-deployment only: sdkConnect refuses it unless CASCADE_ALLOW_STDIO_MCP is set, and the web UI
   *  never exposes it. Present for the extension / a local box where the user owns the machine. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
}

/** One tool as returned by a server's `tools/list`. */
export interface McpToolDef {
  name: string
  description?: string
  inputSchema: Record<string, unknown> // JSON Schema
}

/** What the hub needs from a connection. Abstracted so tests inject a fake (no subprocess / no SDK) — the
 *  real implementation (Phase 9.4) wraps @modelcontextprotocol/sdk. Same DI idea as the model provider. */
export interface McpClient {
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: unknown): Promise<ToolResult>
  close(): Promise<void>
}
export type McpConnect = (name: string, config: McpServerConfig) => Promise<McpClient>

export type McpStatus = 'connecting' | 'ready' | 'failed' | 'disabled'

/** A server's status for the /mcp panel. */
export interface McpServerStatus {
  name: string
  status: McpStatus
  error?: string
  toolNames: string[] // bare tool names (without the mcp__server__ prefix), for display
}

const CONNECT_TIMEOUT_MS = 120_000 // generous (first `npx` run may download the server); then fail with a clear error

/** Reject if `p` doesn't settle within `ms` — so a hung server eventually shows `failed`, not a forever spinner. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
  })
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout])
}

interface ServerState {
  config: McpServerConfig
  status: McpStatus
  client?: McpClient
  tools: Tool[]
  error?: string
}

export class McpHub {
  private readonly servers = new Map<string, ServerState>()
  private pending: Promise<void>[] = []

  constructor(
    configs: Record<string, McpServerConfig>,
    private readonly connectFn: McpConnect,
  ) {
    for (const [name, config] of Object.entries(configs)) {
      this.servers.set(name, { config, status: config.disabled ? 'disabled' : 'connecting', tools: [] })
    }
  }

  /** Kick off connecting every enabled server — in the BACKGROUND (we don't await). */
  start(): void {
    for (const [name, s] of this.servers) if (s.status !== 'disabled') this.pending.push(this.connectServer(name))
  }

  private async connectServer(name: string): Promise<void> {
    const s = this.servers.get(name)!
    s.status = 'connecting'
    s.error = undefined
    try {
      const client = await withTimeout(this.connectFn(name, s.config), CONNECT_TIMEOUT_MS, 'connect')
      const defs = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'tools/list') // ← discovery
      s.client = client
      s.tools = defs.map((d) => wrapMcpTool(name, client, d))
      s.status = 'ready'
    } catch (e) {
      s.status = 'failed' // isolated: one bad server never breaks startup or the others
      s.error = e instanceof Error ? e.message : String(e)
    }
  }

  /** Tools from servers that are READY — the only ones safe to advertise to the model. */
  readyTools(): Tool[] {
    const out: Tool[] = []
    for (const s of this.servers.values()) if (s.status === 'ready') out.push(...s.tools)
    return out
  }

  /** Reconnect any failed server (call lazily, e.g. at the start of a turn). Background. */
  retryFailed(): void {
    for (const [name, s] of this.servers) if (s.status === 'failed') this.pending.push(this.connectServer(name))
  }

  /** Manually (re)connect one server — for the /mcp panel's Connect/Retry button. Background. */
  connect(name: string): void {
    if (this.servers.has(name)) this.pending.push(this.connectServer(name))
  }

  /** Manually stop one server: close its client, drop its tools, mark disabled. For the /mcp panel. */
  async disconnect(name: string): Promise<void> {
    const s = this.servers.get(name)
    if (!s) return
    await s.client?.close().catch(() => {})
    s.client = undefined
    s.tools = []
    s.status = 'disabled'
    s.error = undefined
  }

  statuses(): McpServerStatus[] {
    const prefix = (name: string) => `mcp__${name}__`
    return [...this.servers].map(([name, s]) => ({
      name,
      status: s.status,
      error: s.error,
      toolNames: s.tools.map((t) => t.name.replace(prefix(name), '')),
    }))
  }

  /** Wait for all in-flight connects — for tests (prod never awaits; connecting is background). */
  async settled(): Promise<void> {
    await Promise.allSettled(this.pending)
  }

  async dispose(): Promise<void> {
    for (const s of this.servers.values()) await s.client?.close().catch(() => {})
  }
}

/** Wrap an MCP tool definition as a Cascade `Tool`. Note `parameters` (raw JSON Schema, not Zod) and the
 *  conservative flags — an unknown external tool is treated as a mutating, non-parallel write, so under
 *  `default` permission mode it will prompt. The namespaced name can't collide with builtins. */
function wrapMcpTool(server: string, client: McpClient, def: McpToolDef): Tool {
  return {
    name: `mcp__${server}__${def.name}`,
    description: def.description ?? '',
    parameters: def.inputSchema,
    activitySummary: () => `${server}: ${def.name}`,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    call: (input) => client.callTool(def.name, input),
  }
}
