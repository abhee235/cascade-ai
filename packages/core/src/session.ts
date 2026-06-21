// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//
// A CascadeSession is the ONLY thing a frontend touches. The extension calls createSession()
// in-process; the web app talks to a server that calls createSession() on its behalf and relays
// ActivityEvents over WebSocket. Either way the contract is identical.
//
// The session wrapper around the query loop.
//
// Phase 0: submit() is a stub that simply echoes the user's text back as a final `message`.
// Phases 1+ replace the body with the real model call and agent loop — the contract stays the same.

import type { ActivityEvent } from './protocol'

export interface SessionOptions {
  cwd: string
  model: string
  baseUrl: string
}

export interface CascadeSession {
  /** Drive one user turn. Yields activity; ends with a final `message` then `turnDone`. */
  submit(userText: string): AsyncIterable<ActivityEvent>
  /** Answer a pending permission request (Phase 7+). No-op in Phase 0. */
  respondPermission(id: string, decision: 'allow' | 'allow-always' | 'deny'): void
  /** Cancel the in-flight turn (Phase 8+). No-op in Phase 0. */
  abort(): void
}

export function createSession(opts: SessionOptions): CascadeSession {
  void opts // unused until Phase 1 (model/baseUrl/cwd come into play then)

  return {
    async *submit(userText: string): AsyncIterable<ActivityEvent> {
      yield { type: 'status', text: 'Thinking…' }

      // Phase 0 stub: echo. Proves the core → frontend pipe end to end.
      yield {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `echo: ${userText}` }],
        },
      }

      yield { type: 'turnDone', steps: 0 }
    },

    respondPermission() {
      /* no-op until Phase 7 */
    },

    abort() {
      /* no-op until Phase 8 */
    },
  }
}
