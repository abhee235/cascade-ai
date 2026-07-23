// ADR-071 — the MCP server registry: a UI-managed mcp.json, persisted, enabled/disabled filtering.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addMcpServer, enabledMcpServers, hasMcpServers, initMcpRegistry, mcpServers, removeMcpServer, toggleMcpServer } from '../src/mcpRegistry'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cascade-mcp-'))
  initMcpRegistry(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('mcpRegistry', () => {
  it('starts empty', () => {
    expect(mcpServers()).toEqual({})
    expect(hasMcpServers()).toBe(false)
  })

  it('adds a server (with env keys) and persists it as portable .mcp.json', () => {
    addMcpServer('tavily', { url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=secret' })
    expect(mcpServers().tavily.url).toContain('tavily.com')
    expect(hasMcpServers()).toBe(true)
    // Persisted under the { mcpServers } shape so the file doubles as a hand-editable .mcp.json.
    const onDisk = JSON.parse(readFileSync(join(root, '.cascade', 'mcp.json'), 'utf8'))
    expect(onDisk.mcpServers.tavily.url).toContain('tavilyApiKey=secret')
  })

  it('survives a restart (re-init re-reads the file)', () => {
    addMcpServer('s', { url: 'https://x.com/mcp' })
    initMcpRegistry(root) // drop the cache, same dir — like a server restart
    expect(mcpServers().s.url).toBe('https://x.com/mcp')
  })

  it('enabledMcpServers excludes disabled ones (what a session actually connects)', () => {
    addMcpServer('on', { url: 'https://a.com' })
    addMcpServer('off', { url: 'https://b.com' })
    toggleMcpServer('off', true)
    expect(Object.keys(enabledMcpServers())).toEqual(['on']) // disabled 'off' is withheld from sessions…
    expect(Object.keys(mcpServers())).toHaveLength(2) // …but still shown in the management list
  })

  it('toggle back on re-enables', () => {
    addMcpServer('s', { url: 'https://a.com' })
    toggleMcpServer('s', true)
    expect(enabledMcpServers()).toEqual({})
    toggleMcpServer('s', false)
    expect(Object.keys(enabledMcpServers())).toEqual(['s'])
  })

  it('remove deletes it', () => {
    addMcpServer('s', { url: 'https://a.com' })
    removeMcpServer('s')
    expect(mcpServers()).toEqual({})
  })
})
