// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//

// Phase 3: the session now keeps conversation HISTORY (a Message[]) and a system prompt. The model is
// stateless — "memory" is just us resending the whole transcript every turn. submit() appends the user
// turn, streams the reply (forwarding deltas live — ADR-013), then appends the assistant turn.

import type { ActivityEvent, Message } from './protocol'
import type { ModelProvider } from './llm/provider'
import { runAgentLoop } from './agent/agentLoop'
import type { PermissionController, PermissionMode, PermissionState } from './permissions/gate'

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
}

export interface CascadeSession {
  submit(userText: string): AsyncIterable<ActivityEvent>
  respondPermission(id: string, decision: 'allow' | 'allow-always' | 'deny'): void
  abort(): void
  /** Clear conversation history ("New chat"). */
  reset(): void
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

  return {
    async *submit(userText: string): AsyncIterable<ActivityEvent> {
      const controller = new AbortController()
      inFlight = controller

      messages.push({ role: 'user', content: userText }) // append the user turn to history

      try {
        // Delegate to the agentic loop. It streams, runs tools, appends results, and loops until
        // the model stops asking for tools — yielding ActivityEvents the whole way (Phase 4).
        yield* runAgentLoop(messages, {
          provider: opts.provider,
          model: opts.model,
          cwd: opts.cwd,
          signal: controller.signal,
          permission,
        })
      } catch (err) {
        const msg =
          err instanceof Error && err.name === 'AbortError'
            ? '⏹ Cancelled.'
            : `⚠️ ${err instanceof Error ? err.message : String(err)}`
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
  }
}
