// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//
// A CascadeSession is the ONLY thing a frontend touches. The extension calls createSession()
// in-process; the web app talks to a server that calls createSession() on its behalf and relays
// ActivityEvents over WebSocket. Either way the contract is identical.
//
// The session wrapper around the query loop.
//
// Phase 1: submit() makes one non-streaming Ollama call and emits the reply as a final `message`.
// Still activity-first (ADR-013): we show a status while waiting, then render the whole answer.
// No conversation history yet — that's Phase 3. No tools yet — that's Phase 4.

import type { ActivityEvent } from './protocol'
import { callOllama } from './llm/modelClient'

export interface SessionOptions {
  cwd: string
  model: string
  baseUrl: string
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

      yield { type: 'status', text: `Calling ${opts.model}…` }

      try {
        const reply = await callOllama([{ role: 'user', content: userText }], {
          baseUrl: opts.baseUrl,
          model: opts.model,
          signal: controller.signal,
        })
        yield {
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
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
