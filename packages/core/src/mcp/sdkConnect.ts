// mcp/sdkConnect.ts — the REAL McpConnect, backed by @modelcontextprotocol/sdk (stdio transport).
//
// Kept in its own file so the SDK is only loaded when a frontend actually wires MCP — the deterministic
// tests use a fake McpConnect and never import this.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpClient, McpConnect } from './mcpHub'

/** Spawn the server over stdio, do the MCP handshake, and adapt its client to our McpClient interface. */
export const sdkConnect: McpConnect = async (_name, config) => {
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env })
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
