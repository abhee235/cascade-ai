// core/session.ts — the frontend-agnostic entry point. — ADR-018.
//

// Phase 3: the session now keeps conversation HISTORY (a Message[]) and a system prompt. The model is
// stateless — "memory" is just us resending the whole transcript every turn. submit() appends the user
// turn, streams the reply (forwarding deltas live — ADR-013), then appends the assistant turn.

import type { ActivityEvent, ContentBlock, Message } from './protocol'
import type { ModelProvider } from './llm/provider'
import { buildSystemPrompt } from './agent/systemPrompt'

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
      yield { type: 'status', text: 'Thinking…' }

      let text = ''
      let thinking = ''
      try {
        // Send the FULL history + a fresh system prompt. Forward deltas live (ADR-013).
        for await (const ev of opts.provider.stream(
          { messages, model: opts.model, system: buildSystemPrompt({ cwd: opts.cwd }) },
          controller.signal,
        )) {
          if (ev.type === 'thinking_delta') {
            thinking += ev.thinking
            yield { type: 'thinking_delta', thinking: ev.thinking }
          } else if (ev.type === 'text_delta') {
            text += ev.text
            yield { type: 'text_delta', text: ev.text }
          }
        }

        // Append the assistant turn to history (text only — thinking is display-only, not resent).
        messages.push({ role: 'assistant', content: [{ type: 'text', text }] })

        const content: ContentBlock[] = []
        if (thinking) content.push({ type: 'thinking', thinking })
        content.push({ type: 'text', text })
        yield { type: 'message', message: { role: 'assistant', content } }
      } catch (err) {
        // Roll back the dangling user turn so history stays consistent, then surface the error.
        messages.pop()
        const msg =
          err instanceof Error && err.name === 'AbortError'
            ? '⏹ Cancelled.'
            : `⚠️ ${err instanceof Error ? err.message : String(err)}`
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: msg }] } }
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

    reset() {
      messages.length = 0
    },
  }
}
