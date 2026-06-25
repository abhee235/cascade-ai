// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//

// Phase 3: the session now keeps conversation HISTORY (a Message[]) and a system prompt. The model is
// stateless — "memory" is just us resending the whole transcript every turn. submit() appends the user
// turn, streams the reply (forwarding deltas live — ADR-013), then appends the assistant turn.

import type { ActivityEvent, Message } from './protocol'
import type { ModelProvider } from './llm/provider'
import { runAgentLoop } from './agent/agentLoop'
import type { PermissionController, PermissionMode, PermissionState } from './permissions/gate'
import { NoopTracer, type Tracer } from './observability/tracer'
import { createRegistry } from './tools/toolRegistry'
import { McpHub, type McpServerConfig, type McpConnect, type McpServerStatus } from './mcp/mcpHub'

export interface SessionOptions {
  cwd: string
  provider: ModelProvider
  model: string
  /** How tool calls are gated. The FRONTEND chooses this: 'default' (extension) asks for writes;
   *  'bypass' (sandboxed web) allows everything. Defaults to 'default'. */
  mode?: PermissionMode
  /** Tool names pre-allowed / pre-denied (e.g. from settings). */
  allow?: string[]
  deny?: string[]
  /** Optional forensic trace sink (ADR-023). Omit ⇒ NoopTracer (no output). */
  tracer?: Tracer
  /** MCP servers to register (Phase 9). Connected in the BACKGROUND at startup (ADR-014). */
  mcpServers?: Record<string, McpServerConfig>
  /** How to connect an MCP server. Injected so the real SDK adapter (or a fake) is pluggable. */
  mcpConnect?: McpConnect
}

export interface CascadeSession {
  submit(userText: string): AsyncIterable<ActivityEvent>
  respondPermission(id: string, decision: 'allow' | 'allow-always' | 'deny'): void
  abort(): void
  /** Clear conversation history ("New chat"). */
  reset(): void
  /** Tear down MCP subprocesses etc. Call when discarding the session. */
  dispose(): Promise<void>
  /** MCP panel (/mcp): current server statuses, and manual connect/disconnect. */
  mcpStatuses(): McpServerStatus[]
  mcpConnect(name: string): void
  mcpDisconnect(name: string): Promise<void>
}

export function createSession(opts: SessionOptions): CascadeSession {
  let inFlight: AbortController | undefined
  const messages: Message[] = [] // conversation history; grows every turn (Phase 10 will compact it)

  // Permission plumbing. `pending` holds, per tool-use id, the resolve() of the promise the scheduler is
  // awaiting. respondPermission(id, …) resolves it — that is the moment the parked loop wakes back up.
  const pending = new Map<string, (d: 'allow' | 'allow-always' | 'deny') => void>()
  const state: PermissionState = {
    mode: opts.mode ?? 'default',
    allow: new Set(opts.allow ?? []),
    deny: new Set(opts.deny ?? []),
  }
  const permission: PermissionController = {
    state,
    request: (id) => new Promise((resolve) => pending.set(id, resolve)),
  }
  const tracer = opts.tracer ?? NoopTracer

  // MCP (Phase 9): build the hub from config and start connecting in the BACKGROUND (non-blocking) so
  // tools are discovered without freezing startup. The registry is builtins + whatever is `ready` now —
  // it's a function, so newly-connected MCP tools appear automatically.
  const hub = opts.mcpServers && opts.mcpConnect ? new McpHub(opts.mcpServers, opts.mcpConnect) : undefined
  hub?.start()
  const registry = createRegistry(() => hub?.readyTools() ?? [])

  return {
    async *submit(userText: string): AsyncIterable<ActivityEvent> {
      const controller = new AbortController()
      inFlight = controller

      messages.push({ role: 'user', content: userText }) // append the user turn to history
      tracer.event({ t: 'submit', text: userText })
      hub?.retryFailed() // lazy retry: give a previously-failed server another chance at the start of a turn

      try {
        // Delegate to the agentic loop. It streams, runs tools, appends results, and loops until
        // the model stops asking for tools — yielding ActivityEvents the whole way (Phase 4).
        yield* runAgentLoop(messages, {
          provider: opts.provider,
          model: opts.model,
          cwd: opts.cwd,
          signal: controller.signal,
          permission,
          tracer,
          registry,
        })
      } catch (err) {
        const msg =
          err instanceof Error && err.name === 'AbortError'
            ? '⏹ Cancelled.'
            : `⚠️ ${err instanceof Error ? err.message : String(err)}`
        tracer.event({ t: 'error', message: msg })
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: msg }] } }
        yield { type: 'turnDone', steps: 0 }
      } finally {
        inFlight = undefined
      }
    },

    respondPermission(id, decision) {
      const resolve = pending.get(id)
      if (resolve) {
        pending.delete(id)
        resolve(decision) // wakes the scheduler awaiting perm.request(id)
      }
    },

    abort() {
      inFlight?.abort()
      // Unblock any pending permission prompt so the loop can unwind instead of hanging forever.
      for (const [id, resolve] of pending) resolve('deny'), pending.delete(id)
    },

    reset() {
      messages.length = 0
      // Drop any allow-always rules granted DURING the chat so a new chat truly starts fresh (the gate
      // asks again). Mode and the settings-seeded allow/deny rules are preserved — only the runtime
      // "always allow X" grants are forgotten. (Mutate in place: the controller holds `state` by ref.)
      state.allow = new Set(opts.allow ?? [])
      state.deny = new Set(opts.deny ?? [])
    },

    async dispose() {
      await hub?.dispose() // close MCP subprocesses — no zombies (Phase 9 pitfall)
    },

    mcpStatuses: () => hub?.statuses() ?? [],
    mcpConnect: (name) => hub?.connect(name),
    async mcpDisconnect(name) {
      await hub?.disconnect(name)
    },
  }
}
