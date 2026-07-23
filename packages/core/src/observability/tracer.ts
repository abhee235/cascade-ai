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
import type { TokenUsage } from '../llm/provider'

/** One forensic event. Serializable (plain JSON) like ActivityEvent — but richer and untruncated. */
export type TraceEvent =
  | { t: 'submit'; text: string }
  // provider/model: WHO answered this turn. Without them a trace can't settle "was my selected model
  // actually used?" — the question that otherwise costs an `ollama ps` + `nvidia-smi` + event-count audit.
  // contextWindow: what the prompt is being sized AGAINST. Without it a viewer can only sum tokens across
  // calls (throughput), which looks alarming — 344k across 12 calls — while actual occupancy never left 34%.
  | { t: 'model_request'; turn: number; provider: string; model: string; contextWindow?: number; system: string; tools: string[]; messages: Message[] }
  | { t: 'model_response'; turn: number; text: string; thinking: string; toolUses: { id: string; name: string; input: unknown }[]; usage?: TokenUsage } // usage: E1/ADR-040 — token counts + (Ollama-native) prefill/decode/load durations, the KV-cache observables
  | { t: 'permission'; id: string; tool: string; decision: string; asked: boolean } // asked=true ⇒ a prompt was shown
  | { t: 'tool_call'; id: string; name: string; input: unknown; repaired?: boolean }
  | { t: 'tool_result'; id: string; name: string; ok: boolean; ms: number; content: string }
  | { t: 'compaction'; kind: string; tokensBefore: number; tokensAfter: number; forced: boolean } // E1/ADR-039: which layer fired + what it reclaimed (estimates)
  | { t: 'verify_gate'; turn: number } // ADR-049: terminal answer refused — edits happened, nothing verified them; nudge injected
  | { t: 'delegate_nudge'; turn: number; readTokens: number } // ADR-050: bulk-read pressure crossed the threshold with zero delegation; reminder injected
  | { t: 'plan_nudge'; turn: number } // ADR-056 rung 2: writes began with no PLAN.md and no planner spawn; exact Subagent call injected
  | { t: 'degraded_retry'; turn: number } // empty terminal response (no text/thinking/tools) — backend recycled once and the turn re-asked
  | { t: 'todo_gate'; turn: number; open: number } // terminal answer refused once: the model's own todo list still has `open` unfinished items
  | { t: 'read_loop'; turn: number; path: string } // ADR-058: same file read N times with no Write/Edit to it — act-now reminder injected
  | { t: 'stalled_verify'; turn: number } // ADR-058: edits pending unverified for N consecutive turns mid-flight — run-the-check reminder injected
  | { t: 'post_edit_check'; turn: number; files: number } // ADR-059: harness type check after a mutating turn found errors — pushed to the model
  | { t: 'slow_prefill'; turn: number; waitedMs: number } // ADR-061: pre-first-token silence with a LIVE backend — a big cold prefill, waited out instead of killed
  | { t: 'max_tokens_cut'; turn: number } // 2026-07-23: a no-tool-call turn hit the output ceiling (thinking runaway) — continued with an "act now" nudge instead of accepting the truncated answer
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
