// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//
// A CascadeSession is the ONLY thing a frontend touches. The extension calls createSession()
// in-process; the web app talks to a server that calls createSession() and relays ActivityEvents
// over WebSocket. Either way the contract is identical.
//
// The session wrapper around the query loop.
//
// The session depends on a ModelProvider (injected) — NOT on Ollama/OpenAI/etc. (ADR-020). The
// frontend builds the provider via createProvider() and passes it in.
//
// Phase 1: submit() makes one non-streaming completion and emits the reply as a final `message`.
// Activity-first (ADR-013): status while waiting, then the whole answer. No history yet (Phase 3),
// no tools yet (Phase 4).

import type { ActivityEvent } from './protocol'
import type { ModelProvider } from './llm/provider'

export interface SessionOptions {
  cwd: string
  /** The model provider, built by the frontend via createProvider() and injected here. */
  provider: ModelProvider
  /** Model id passed to the provider on each request. */
  model: string
}

export interface CascadeSession {
  /** Drive one user turn. Yields activity; ends with a final `message` then `turnDone`. */
  submit(userText: string): AsyncIterable<ActivityEvent>
  /** Answer a pending permission request (Phase 7+). No-op until then. */
  respondPermission(id: string, decision: 'allow' | 'allow-always' | 'deny'): void
  /** Cancel the in-flight turn. Wired to an AbortController; full UX in Phase 8. */
  abort(): void
}

export function createSession(opts: SessionOptions): CascadeSession {
  let inFlight: AbortController | undefined

  return {
    async *submit(userText: string): AsyncIterable<ActivityEvent> {
      const controller = new AbortController()
      inFlight = controller

      yield { type: 'status', text: `Calling ${opts.provider.id} (${opts.model})…` }

      try {
        const { text } = await opts.provider.complete(
          { messages: [{ role: 'user', content: userText }], model: opts.model },
          controller.signal,
        )
        yield {
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        }
      } catch (err) {
        // Never fail silently — surface the error in the transcript so it's visible in the UI.
        const text =
          err instanceof Error && err.name === 'AbortError'
            ? '⏹ Cancelled.'
            : `⚠️ ${err instanceof Error ? err.message : String(err)}`
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } }
      } finally {
        inFlight = undefined
      }

      yield { type: 'turnDone', steps: 0 }
    },

    respondPermission() {
      /* no-op until Phase 7 */
    },

    abort() {
      inFlight?.abort()
    },
  }
}
