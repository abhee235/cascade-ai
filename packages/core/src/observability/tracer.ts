// observability/tracer.ts — trace the agent end-to-end as JSONL. — ADR-023.
//
// This is a SECOND event stream, distinct from ActivityEvent. ActivityEvent is for DISPLAY (truncated
// previews, no raw model I/O). TraceEvent is for FORENSICS: the FULL request we sent the model, the full
// response, every tool input/output, permission decisions, and timing — so "why did it go wrong?" has an
// answer. It's injected by DI like the provider (ADR-020); the default NoopTracer keeps tests/headless silent.
//
// Format: JSONL — one event per line, append-only.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import type { Message } from '../protocol'

/** One forensic event. Serializable (plain JSON) like ActivityEvent — but richer and untruncated. */
export type TraceEvent =
  | { t: 'submit'; text: string }
  | { t: 'model_request'; turn: number; system: string; tools: string[]; messages: Message[] }
  | { t: 'model_response'; turn: number; text: string; thinking: string; toolUses: { id: string; name: string; input: unknown }[]; usage?: { inputTokens?: number; outputTokens?: number } } // usage: E1/ADR-040 — backend-reported token counts for this call
  | { t: 'permission'; id: string; tool: string; decision: string; asked: boolean } // asked=true ⇒ a prompt was shown
  | { t: 'tool_call'; id: string; name: string; input: unknown; repaired?: boolean }
  | { t: 'tool_result'; id: string; name: string; ok: boolean; ms: number; content: string }
  | { t: 'compaction'; kind: string; tokensBefore: number; tokensAfter: number; forced: boolean } // E1/ADR-039: which layer fired + what it reclaimed (estimates)
  | { t: 'verify_gate'; turn: number } // ADR-049: terminal answer refused — edits happened, nothing verified them; nudge injected
  | { t: 'delegate_nudge'; turn: number; readTokens: number } // ADR-050: bulk-read pressure crossed the threshold with zero delegation; reminder injected
  | { t: 'hook'; event: string; id: string; tool: string; decision: string; ms: number } // ADR-036: a project hook decided (allow|deny|ask) for a tool call
  | { t: 'turn_done'; turns: number }
  | { t: 'error'; message: string }

export interface Tracer {
  event(e: TraceEvent): void
}

/** Default: trace nothing. So omitting a tracer (tests, smoke) has zero cost or output. */
export const NoopTracer: Tracer = { event() {} }

/** Appends one JSON object per line (JSONL): greppable, jq-able, append-only. Each line is stamped with a
 *  wall-clock `ts` and a monotonic `seq` so you can order/diff events even at sub-millisecond spacing. */
export class JsonlTracer implements Tracer {
  private readonly stream: WriteStream
  private seq = 0

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.stream = createWriteStream(path, { flags: 'a' }) // 'a' = append, never clobber a prior run
  }

  event(e: TraceEvent): void {
    // JSON.stringify reads `messages` at write time (synchronous), so we capture the live snapshot without cloning.
    this.stream.write(`${JSON.stringify({ ts: new Date().toISOString(), seq: this.seq++, ...e })}\n`)
  }
}
