// llm/resilience.ts — wrap the model call so transient failures retry, overflow recovers (compact), and
// fatal errors fail fast. — ADR-016.
//
// `streamWithRecovery` wraps the provider's STREAM so live token streaming (ADR-013) is preserved on the
// happy path: each attempt re-creates and re-yields the stream; the UI's streaming view is transient and the
// final `message` is authoritative, so a re-stream on retry self-corrects.

import type { StreamEvent } from './provider'

export type ErrorKind = 'abort' | 'overflow' | 'transient' | 'fatal'

/** Classify an error into the retry taxonomy (the crux — see resilience-and-subagents-design.md). */
export function classifyError(err: unknown): ErrorKind {
  const e = err as { name?: string; code?: string; status?: number; statusCode?: number; message?: string; cause?: { code?: string } }
  if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') return 'abort'

  const msg = String(e?.message ?? err ?? '').toLowerCase()
  if (/context (length|window)|num_ctx|exceed|too long|too many tokens|maximum context/.test(msg)) return 'overflow'

  const code = e?.code ?? e?.cause?.code
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') return 'transient'

  const status = e?.status ?? e?.statusCode
  if (typeof status === 'number') {
    if (status === 408 || status === 409 || status === 429 || status === 529 || status >= 500) return 'transient'
    return 'fatal' // 400/401/403/404 — deterministic, don't retry
  }
  if (/fetch failed|network|timeout|socket hang up|econnrefused/.test(msg)) return 'transient'
  return 'fatal'
}

export interface RecoveryOptions {
  maxRetries?: number // transient retries (default 4)
  maxOverflowRetries?: number // compact-then-retry attempts (default 2)
  baseDelayMs?: number // default 500
  maxDelayMs?: number // default 30_000
  signal?: AbortSignal
  /** Recover from context overflow (e.g. compact the history) before retrying. Return value ignored. */
  onOverflow?: () => Promise<void>
  onRetry?: (info: { attempt: number; delayMs: number; reason: ErrorKind }) => void
  sleep?: (ms: number) => Promise<void> // injectable for deterministic tests
}

export class RecoveryError extends Error {
  constructor(public readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original))
    this.name = 'RecoveryError'
  }
}

/** Exponential backoff with jitter, capped. */
function backoff(attempt: number, base: number, max: number): number {
  const d = Math.min(base * 2 ** (attempt - 1), max)
  return d + Math.random() * 0.25 * d // jitter de-synchronizes retries (no thundering herd)
}

/** Drive a provider stream with recovery. `make` is called once per attempt (re-reads the latest messages,
 *  so onOverflow's compaction takes effect on the retry). */
export async function* streamWithRecovery(make: () => AsyncIterable<StreamEvent>, opts: RecoveryOptions = {}): AsyncGenerator<StreamEvent> {
  const maxRetries = opts.maxRetries ?? 4
  const maxOverflow = opts.maxOverflowRetries ?? 2
  const base = opts.baseDelayMs ?? 500
  const max = opts.maxDelayMs ?? 30_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let transientAttempts = 0
  let overflowAttempts = 0

  while (true) {
    try {
      for await (const ev of make()) yield ev
      return // stream completed
    } catch (err) {
      if (opts.signal?.aborted) throw err
      const kind = classifyError(err)

      if (kind === 'abort') throw err

      if (kind === 'overflow') {
        if (opts.onOverflow && overflowAttempts < maxOverflow) {
          overflowAttempts++
          opts.onRetry?.({ attempt: overflowAttempts, delayMs: 0, reason: 'overflow' })
          await opts.onOverflow() // e.g. compact, then retry with the smaller history — no backoff
          continue
        }
        throw new RecoveryError(err) // can't shrink further
      }

      if (kind === 'transient' && transientAttempts < maxRetries) {
        transientAttempts++
        const delayMs = backoff(transientAttempts, base, max)
        opts.onRetry?.({ attempt: transientAttempts, delayMs, reason: 'transient' })
        await sleep(delayMs)
        continue
      }

      throw new RecoveryError(err) // fatal, or retries exhausted
    }
  }
}
