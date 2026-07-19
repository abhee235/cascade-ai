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
  const e = err as { name?: string; code?: string; status?: number; statusCode?: number; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') return 'abort'

  // Look at the whole error: message + the cause chain (undici wraps the real reason in `cause`).
  const msg = `${String(e?.message ?? err ?? '')} ${String(e?.cause?.message ?? '')}`.toLowerCase()
  if (/context (length|window)|num_ctx|exceed|too long|too many tokens|maximum context/.test(msg)) return 'overflow'

  const code = String(e?.code ?? e?.cause?.code ?? '')
  if (/^(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR)/i.test(code)) return 'transient'

  const status = e?.status ?? e?.statusCode
  if (typeof status === 'number') {
    if (status === 408 || status === 409 || status === 429 || status === 529 || status >= 500) return 'transient'
    return 'fatal' // 400/401/403/404 — deterministic, don't retry
  }
  // Streaming connection dropped mid-response: Node/undici throws `TypeError: terminated` (cause:
  // "other side closed" / UND_ERR_SOCKET). Common with Ollama (model loading, brief stall) — and retryable.
  if (/fetch failed|terminated|other side closed|socket|network|timeout|stalled|connection (closed|reset|error)|econn|und_err|premature close/.test(msg)) return 'transient'
  return 'fatal'
}

export interface RecoveryOptions {
  maxRetries?: number // transient retries (default 5)
  maxOverflowRetries?: number // compact-then-retry attempts (default 2)
  baseDelayMs?: number // default 500
  maxDelayMs?: number // default 8_000
  signal?: AbortSignal
  /** Recover from context overflow (e.g. compact the history) before retrying. Return value ignored. */
  onOverflow?: () => Promise<void>
  onRetry?: (info: { attempt: number; delayMs: number; reason: ErrorKind }) => void
  sleep?: (ms: number) => Promise<void> // injectable for deterministic tests
  /** WATCHDOG (in-core, ported from the eval runner): a crashed/hung local backend often returns DEGRADED
   *  until the model is recycled. Called before the 2nd+ consecutive transient retry (best-effort). When it
   *  SUCCEEDS (the adapter verified the backend answers again — e.g. a 1-token reload probe), the transient
   *  budget RESETS: retries were sized for blips (~15s), but a crashed 15GB model takes MINUTES to reload
   *  (measured, iterate-2: rounds died retrying into a still-loading backend that recover() then verified
   *  healthy). Capped by maxRecoveries so a backend that crashes deterministically on the real request
   *  still terminates. */
  recover?: () => Promise<void>
  /** Max times a SUCCESSFUL recover() may reset the transient budget per stream call (default 3). */
  maxRecoveries?: number
  /** WATCHDOG: max ms between STREAM EVENTS before the attempt is declared stalled and retried (a connection
   *  that is open but silent — measured live: an abort went unanswered ~27 min past a run's budget).
   *  Default 180_000; 0 disables. */
  stallTimeoutMs?: number
}

/** A mid-stream stall promoted to an error (classified transient → retried, with recycle). */
export class StallError extends Error {
  constructor(ms: number) {
    super(`stream stalled: no events for ${ms}ms`)
    this.name = 'StallError'
  }
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

/** Race an iterator's next() against a stall timer. SLEEP-AWARE: on the user's box the OS sleeps at 60min —
 *  a timer that fires GROSSLY late (≫ armed delay) means the machine slept, not that the backend stalled;
 *  re-arm once instead of erroring (the backend was asleep too and deserves a fresh chance). */
async function nextWithStallGuard<T>(it: AsyncIterator<T>, stallMs: number): Promise<IteratorResult<T>> {
  for (let rearm = 0; ; rearm++) {
    const armedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const stall = new Promise<'stall'>((r) => {
      timer = setTimeout(() => r('stall'), stallMs)
    })
    try {
      const winner = await Promise.race([it.next().then((r) => ({ r })), stall])
      if (winner !== 'stall') return winner.r
      const late = Date.now() - armedAt - stallMs
      if (late > stallMs && rearm === 0) continue // fired way past its slot ⇒ system slept; one fresh chance
      throw new StallError(stallMs)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Non-streaming twin of streamWithRecovery, for the model calls that live OUTSIDE the main loop —
 *  compaction summarize, memory curation. Measured (iterate-5): those calls were raw `provider.complete`
 *  with NO guard, so one 300s backend wedge on a summarize killed the whole round before the main
 *  (fully-guarded) model call was even made. Same policy as the stream: classify → backoff → recover at
 *  ≥2 consecutive transients → a SUCCESSFUL recover resets the budget (capped). Overflow is NOT retried
 *  here (a too-big summarize prompt won't shrink by retrying — the caller owns that). */
export async function completeWithRecovery<T>(call: () => Promise<T>, opts: RecoveryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5
  const base = opts.baseDelayMs ?? 500
  const max = opts.maxDelayMs ?? 8_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // Per-attempt DEADLINE (measured, iterate-7 live: the backend sent headers then wedged mid-body — a
  // non-streaming complete() has no inter-byte timeout, so the await hung 40+ min and NO guard could fire,
  // because every guard here lives in the catch of a call that never returns). The deadline converts a
  // body-hang into a StallError → transient → the recover/recycle path. The orphaned in-flight promise is
  // detached (its eventual rejection is swallowed); recover()'s reload kills it server-side anyway.
  const attemptMs = opts.stallTimeoutMs ?? 300_000
  let attempts = 0
  let recoveries = 0
  const maxRecoveries = opts.maxRecoveries ?? 3
  while (true) {
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const attempt = call()
      attempt.catch(() => {}) // if the deadline wins, the orphan's late rejection must not be unhandled
      const raced =
        attemptMs > 0
          ? await Promise.race([attempt, new Promise<never>((_, reject) => (deadline = setTimeout(() => reject(new StallError(attemptMs)), attemptMs)))])
          : await attempt
      return raced
    } catch (err) {
      const kind = classifyError(err)
      if (kind !== 'transient' || attempts >= maxRetries) throw err instanceof RecoveryError ? err : new RecoveryError(err)
      attempts++
      const delayMs = backoff(attempts, base, max)
      opts.onRetry?.({ attempt: attempts, delayMs, reason: 'transient' })
      if (attempts >= 2 && opts.recover && recoveries < maxRecoveries) {
        try {
          await opts.recover()
          recoveries++
          attempts = 0 // verified-healthy backend ⇒ fresh budget (see streamWithRecovery)
        } catch {
          /* best-effort */
        }
      }
      if (opts.signal?.aborted) throw err instanceof RecoveryError ? err : new RecoveryError(err)
      await sleep(delayMs)
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  }
}

/** Drive a provider stream with recovery. `make` is called once per attempt (re-reads the latest messages,
 *  so onOverflow's compaction takes effect on the retry). */
export async function* streamWithRecovery(make: () => AsyncIterable<StreamEvent>, opts: RecoveryOptions = {}): AsyncGenerator<StreamEvent> {
  const maxRetries = opts.maxRetries ?? 5 // ~0.5+1+2+4+8 ≈ 15s window to bring a killed Ollama back
  const maxOverflow = opts.maxOverflowRetries ?? 2
  const base = opts.baseDelayMs ?? 500
  const max = opts.maxDelayMs ?? 8_000
  const stallMs = opts.stallTimeoutMs ?? 180_000
  // Backoff sleep must observe the ABORT signal — measured cost of not doing so: a Stop during a long
  // backoff waits out the full delay before the loop notices.
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(done, ms)
        function done() {
          opts.signal?.removeEventListener('abort', done)
          clearTimeout(t)
          resolve()
        }
        opts.signal?.addEventListener('abort', done, { once: true })
      }))
  let transientAttempts = 0
  let overflowAttempts = 0
  let recoveries = 0
  const maxRecoveries = opts.maxRecoveries ?? 3

  while (true) {
    try {
      if (stallMs > 0) {
        // Pull manually so every await between events is stall-guarded.
        const it = make()[Symbol.asyncIterator]()
        while (true) {
          const r = await nextWithStallGuard(it, stallMs)
          if (r.done) return
          yield r.value
        }
      }
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
          yield { type: 'retry', attempt: overflowAttempts, delayMs: 0, reason: 'overflow' } // tells the loop to reset partial output
          await opts.onOverflow() // e.g. compact, then retry with the smaller history — no backoff
          continue
        }
        throw new RecoveryError(err) // can't shrink further
      }

      if (kind === 'transient' && transientAttempts < maxRetries) {
        transientAttempts++
        const delayMs = backoff(transientAttempts, base, max)
        opts.onRetry?.({ attempt: transientAttempts, delayMs, reason: 'transient' })
        yield { type: 'retry', attempt: transientAttempts, delayMs, reason: 'transient' } // surfaced to the UI; resets partial output
        // WATCHDOG: a crashed/hung local backend often answers again but DEGRADED (empty replies) until
        // the model is recycled — the eval runner learned this over six live crashes; now core knows too.
        if (transientAttempts >= 2 && opts.recover && recoveries < maxRecoveries) {
          try {
            await opts.recover()
            // recover() resolving = the adapter VERIFIED the backend answers again. Retries were budgeted
            // for blips; a crash+reload is a different timescale — grant a fresh budget (capped, so a
            // backend that deterministically dies on the real request still exhausts and fails honestly).
            recoveries++
            transientAttempts = 0
          } catch {
            /* best-effort — the retry proceeds on the remaining budget */
          }
        }
        await sleep(delayMs)
        continue
      }

      throw new RecoveryError(err) // fatal, or retries exhausted
    }
  }
}
