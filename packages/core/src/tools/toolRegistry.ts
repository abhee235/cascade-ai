// tools/toolRegistry.ts — assembles the active tool set + lookup by name.

//
// Phase 9: the active set is no longer a static array — it's builtins + whatever MCP tools are currently
// ready. So we expose a `ToolRegistry` created per session (createRegistry) and injected by DI, exactly
// like the provider/tracer/permission. The registry is computed fresh on each call, so MCP tools appear
// the moment their server becomes ready.

import { z } from 'zod'
import type { Tool } from './Tool'
import type { ToolSchema } from '../llm/provider'
import type { WindowTier } from '../llm/contextWindows'
import { ReadTool } from './builtins/Read'
import { GlobTool } from './builtins/Glob'
import { GrepTool } from './builtins/Grep'
import { WriteTool } from './builtins/Write'
import { EditTool } from './builtins/Edit'
import { BashTool } from './builtins/Bash'
import { MemoryTool } from './builtins/Memory'
import { MemorySearchTool } from './builtins/MemorySearch'
import { SubagentTool } from './builtins/Subagent'
import { TodoWriteTool } from './builtins/TodoWrite'

/** The always-present tools. MCP tools are added dynamically via createRegistry's `extraTools`. */
export const builtinTools: Tool[] = [ReadTool, GlobTool, GrepTool, WriteTool, EditTool, BashTool, TodoWriteTool, MemoryTool, MemorySearchTool, SubagentTool]

/** The JSON Schema to advertise for a tool: a builtin's Zod schema converted, an MCP tool's raw
 *  `parameters` used as-is, or an empty object if neither (no args). */
export function schemaOf(t: Tool): Record<string, unknown> {
  if (t.parameters) return t.parameters
  if (t.inputSchema) return z.toJSONSchema(t.inputSchema) as Record<string, unknown>
  return { type: 'object', properties: {} }
}

/** Resolve a tool's description for a window tier (ADR-037): descriptions are advertised on EVERY request, so
 *  a tool may provide a tier function — rich guidance on big windows, essentials on small ones. Plain strings
 *  (all MCP tools, most builtins) pass through unchanged. */
export function descriptionOf(t: Tool, tier: WindowTier = 'full'): string {
  return typeof t.description === 'function' ? t.description(tier) : t.description
}

/** The active tool set for a turn. Injected via DI (LoopDeps/ToolContext) so it can be DYNAMIC (MCP tools
 *  appear as their servers become ready) and per-session (safe for the multi-frontend web app). */
export interface ToolRegistry {
  list(): Tool[]
  find(name: string): Tool | undefined
  /** Advertised schemas for a turn. `tier` sizes the descriptions to the window (default 'full'). */
  schemas(tier?: WindowTier): ToolSchema[]
}

/** Build a registry of builtins + `extraTools()` (e.g. `() => mcpHub.readyTools()`). `extraTools` is a
 *  function, not an array, so the set is recomputed each call — newly-ready MCP tools show up immediately. */
/** A registry over an arbitrary (dynamic) tool list — e.g. a subagent's filtered subset (Phase 12). */
export function registryOf(tools: () => Tool[]): ToolRegistry {
  return {
    list: tools,
    find: (name) => tools().find((t) => t.name === name),
    schemas: (tier) => tools().map((t) => ({ name: t.name, description: descriptionOf(t, tier), parameters: schemaOf(t) })),
  }
}

export function createRegistry(extraTools: () => Tool[] = () => []): ToolRegistry {
  return registryOf(() => [...builtinTools, ...extraTools()])
}

/** Builtins-only registry — the fallback when none is injected (headless smokes, direct-call tests). */
export const defaultRegistry: ToolRegistry = createRegistry()
