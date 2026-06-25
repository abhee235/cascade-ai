import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpHub, type McpClient, type McpConnect } from '../src/mcp/mcpHub'
import { createRegistry } from '../src/tools/toolRegistry'
import { executeTool } from '../src/tools/runTool'
import { loadMcpServers } from '../src/mcp/loadMcpConfig'

// A fake MCP client — no subprocess, no SDK. Records calls so we can assert routing.
function fakeClient(tools: string[]): McpClient {
  return {
    listTools: async () => tools.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' } })),
    callTool: async (name, args) => ({ content: `${name}(${JSON.stringify(args)})` }),
    close: async () => {},
  }
}

describe('McpHub', () => {
  it('connects in the background, discovers tools, and advertises them namespaced', async () => {
    const connect: McpConnect = async () => fakeClient(['list_dir', 'read_file'])
    const hub = new McpHub({ files: { command: 'whatever' } }, connect)

    expect(hub.readyTools()).toHaveLength(0) // nothing advertised before connect resolves
    hub.start()
    await hub.settled()

    const names = hub.readyTools().map((t) => t.name)
    expect(names).toEqual(['mcp__files__list_dir', 'mcp__files__read_file'])
    expect(hub.statuses()).toEqual([{ name: 'files', status: 'ready', error: undefined, toolNames: ['list_dir', 'read_file'] }])
  })

  it('routes a tool call through to the client (server validates; raw JSON Schema advertised)', async () => {
    const hub = new McpHub({ files: { command: 'x' } }, async () => fakeClient(['echo']))
    hub.start()
    await hub.settled()

    const tool = hub.readyTools()[0]
    expect(tool.parameters).toEqual({ type: 'object' }) // raw JSON Schema, no Zod
    expect(tool.inputSchema).toBeUndefined()
    const res = await tool.call({ msg: 'hi' }, { cwd: '.', abortSignal: new AbortController().signal })
    expect(res.content).toBe('echo({"msg":"hi"})')
  })

  it('a dynamic registry advertises ready MCP tools and executeTool runs them (builtins still present)', async () => {
    const hub = new McpHub({ files: { command: 'x' } }, async () => fakeClient(['echo']))
    hub.start()
    await hub.settled()

    const registry = createRegistry(() => hub.readyTools()) // builtins + ready MCP tools
    const names = registry.schemas().map((s) => s.name)
    expect(names).toContain('Read') // builtin still there
    expect(names).toContain('mcp__files__echo') // MCP tool advertised

    // executeTool finds + runs the MCP tool via the injected registry (no Zod validation; server validates).
    const block = await executeTool(
      { id: '1', name: 'mcp__files__echo', input: { msg: 'hi' } },
      { cwd: '.', abortSignal: new AbortController().signal, registry },
    )
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: '1' })
    expect((block as any).content).toBe('echo({"msg":"hi"})')
  })

  it('a disabled server never connects', async () => {
    const hub = new McpHub({ off: { command: 'x', disabled: true } }, async () => fakeClient(['t']))
    hub.start()
    await hub.settled()
    expect(hub.statuses()[0].status).toBe('disabled')
    expect(hub.readyTools()).toHaveLength(0)
  })

  it('disconnect closes a ready server and drops its tools (for the /mcp panel)', async () => {
    const hub = new McpHub({ files: { command: 'x' } }, async () => fakeClient(['echo']))
    hub.start()
    await hub.settled()
    expect(hub.readyTools()).toHaveLength(1)

    await hub.disconnect('files')
    expect(hub.statuses()[0]).toMatchObject({ status: 'disabled', toolNames: [] })
    expect(hub.readyTools()).toHaveLength(0)
  })

  it('a failing server is marked failed (isolated), then recovers on retry', async () => {
    let attempt = 0
    const connect: McpConnect = async () => {
      attempt++
      if (attempt === 1) throw new Error('boom')
      return fakeClient(['ok'])
    }
    const hub = new McpHub({ flaky: { command: 'x' } }, connect)

    hub.start()
    await hub.settled()
    expect(hub.statuses()[0]).toMatchObject({ status: 'failed', error: 'boom' })
    expect(hub.readyTools()).toHaveLength(0)

    hub.retryFailed() // lazy retry on next use
    await hub.settled()
    expect(hub.statuses()[0].status).toBe('ready')
    expect(hub.readyTools().map((t) => t.name)).toEqual(['mcp__flaky__ok'])
  })
})

describe('loadMcpServers (.mcp.json)', () => {
  it('reads the mcpServers map; missing or invalid file ⇒ {}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-mcpcfg-'))
    try {
      expect(loadMcpServers(dir)).toEqual({}) // no file
      await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { p: { command: 'npx', args: ['x'] } } }))
      expect(loadMcpServers(dir)).toEqual({ p: { command: 'npx', args: ['x'] } })
      await writeFile(join(dir, '.mcp.json'), 'not json{')
      expect(loadMcpServers(dir)).toEqual({}) // invalid ⇒ no crash, no servers
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
