// mcp/sdkConnect.ts — the REAL McpConnect, backed by @modelcontextprotocol/sdk.
//
// Two transports: HTTP (streamable) — remote, no subprocess, SAFE on a hosted server — and stdio, which
// spawns a subprocess and is therefore arbitrary code execution on the host. HTTP is preferred; stdio is
// refused unless CASCADE_ALLOW_STDIO_MCP is set (a local/trusted box the user owns). Kept in its own file so
// the SDK loads only when a frontend wires MCP.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpClient, McpConnect } from './mcpHub'

/** Connect to the server (HTTP or stdio), do the MCP handshake, and adapt its client to our McpClient. */
export const sdkConnect: McpConnect = async (_name, config) => {
  let transport
  if (config.url) {
    // Remote HTTP MCP — no process spawned. Auth: a header, or a token already in the URL query (Tavily).
    transport = new StreamableHTTPClientTransport(new URL(config.url), config.headers ? { requestInit: { headers: config.headers } } : undefined)
  } else if (config.command) {
    // A subprocess is code execution on the host — only allow it on a deployment that opted in.
    if (typeof process !== 'undefined' && !process.env.CASCADE_ALLOW_STDIO_MCP) {
      throw new Error('stdio MCP is disabled (it spawns a subprocess). Use an HTTP MCP URL, or set CASCADE_ALLOW_STDIO_MCP=1 on a machine you own.')
    }
    transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env })
  } else {
    throw new Error('MCP server config needs a `url` (HTTP) or a `command` (stdio).')
  }
  const client = new Client({ name: 'cascade', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport) // performs `initialize`

  const adapter: McpClient = {
    async listTools() {
      const res = await client.listTools()
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }))
    },
    async callTool(name, args) {
      const res = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> })
      // MCP returns content as an array of typed parts; flatten text parts into our string tool_result.
      const parts = Array.isArray(res.content) ? res.content : []
      const content = parts.map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
      return { content: content || '(no output)', isError: !!res.isError }
    },
    async close() {
      await client.close()
    },
  }
  return adapter
}
