// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//

// Phase 3: the session now keeps conversation HISTORY (a Message[]) and a system prompt. The model is
// stateless — "memory" is just us resending the whole transcript every turn. submit() appends the user
// turn, streams the reply (forwarding deltas live — ADR-013), then appends the assistant turn.

import type { ActivityEvent, Message } from './protocol'
import type { ModelProvider } from './llm/provider'
import { runAgentLoop } from './agent/agentLoop'

export interface SessionOptions {
  cwd: string
  provider: ModelProvider
  model: string
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

    respondPermission() {
      /* no-op until Phase 7 */
    },

    abort() {
      inFlight?.abort()
    },

    reset() {
      messages.length = 0
    },
  }
}
