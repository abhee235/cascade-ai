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

import type { ActivityEvent, ContentBlock } from './protocol'
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

      yield { type: 'status', text: 'Thinking…' }

      try {
        // Consume the provider's token stream and FORWARD deltas live to the UI (ADR-013, revised):
        // prose + thinking stream token-by-token, like the mainstream editor assistants. We also accumulate so
        // we can emit a final authoritative `message` the UI commits (and Phase 3 stores).
        let text = ''
        let thinking = ''
        for await (const ev of opts.provider.stream(
          { messages: [{ role: 'user', content: userText }], model: opts.model },
          controller.signal,
        )) {
          if (ev.type === 'thinking_delta') {
            thinking += ev.thinking
            yield { type: 'thinking_delta', thinking: ev.thinking }
          } else if (ev.type === 'text_delta') {
            text += ev.text
            yield { type: 'text_delta', text: ev.text }
          }
          // 'done' just ends the loop; we finalize below.
        }

        // Finalize: emit the whole message so the UI commits it (replaces the live buffer).
        const content: ContentBlock[] = []
        if (thinking) content.push({ type: 'thinking', thinking })
        content.push({ type: 'text', text })
        yield { type: 'message', message: { role: 'assistant', content } }
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
