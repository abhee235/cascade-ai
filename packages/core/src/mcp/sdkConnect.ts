// mcp/sdkConnect.ts — the REAL McpConnect, backed by @modelcontextprotocol/sdk.
//
// Two transports: HTTP (streamable) — remote, no subprocess, SAFE on a hosted server — and stdio, which
// spawns a subprocess and is therefore arbitrary code execution on the host. Whether stdio is allowed is a
// FRONTEND trust declaration (`makeSdkConnect`), not per-server config: server-side MCP config lives next to
// model-writable project dirs, so a config field could be flipped by a model-written .mcp.json — the exact
// escalation this guard exists to stop. The extension opts in (the user's own machine + user-authored
// .mcp.json — the user trusts their own config); the web server stays refused unless CASCADE_ALLOW_STDIO_MCP is
// set. Kept in its own file so the SDK loads only when a frontend wires MCP.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpClient, McpConnect } from './mcpHub'

/** Build an McpConnect with this frontend's trust posture. `allowStdio: true` = the frontend runs on a
 *  machine the user owns with user-authored config (the VS Code extension). Omit ⇒ stdio refused unless
 *  the CASCADE_ALLOW_STDIO_MCP env opt-in is set (the hosted/server default). */
export function makeSdkConnect(opts: { allowStdio?: boolean } = {}): McpConnect {
  return async (_name, config) => {
    let transport
    if (config.url) {
      // Remote HTTP MCP — no process spawned. The key is stored SEPARATELY from the endpoint (so it can be
      // rotated / the host changed independently) and applied HERE, per apiKeyIn: a query param, a header,
      // or a Bearer token.
      const u = new URL(config.url)
      const headers: Record<string, string> = { ...config.headers }
      if (config.apiKey && config.apiKeyIn) {
        if (config.apiKeyIn.startsWith('query:')) u.searchParams.set(config.apiKeyIn.slice(6), config.apiKey)
        else if (config.apiKeyIn.startsWith('header:')) headers[config.apiKeyIn.slice(7)] = config.apiKey
        else if (config.apiKeyIn === 'bearer') headers.Authorization = `Bearer ${config.apiKey}`
      }
      transport = new StreamableHTTPClientTransport(u, Object.keys(headers).length ? { requestInit: { headers } } : undefined)
    } else if (config.command) {
      // A subprocess is code execution on the host — only allow it when the frontend declared trust
      // (extension) or the deployment opted in via env (server on a machine the user owns).
      const allowStdio = opts.allowStdio ?? (typeof process !== 'undefined' && !!process.env.CASCADE_ALLOW_STDIO_MCP)
      if (!allowStdio) {
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
}

/** The default McpConnect (hosted/server trust posture): HTTP always; stdio only with the env opt-in.
 *  Behavior is byte-for-byte what it was before `makeSdkConnect` existed. */
export const sdkConnect: McpConnect = makeSdkConnect()
