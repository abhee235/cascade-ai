# ADR-016 — Resilience: recover the model call (retry / overflow→compact / fail-fast)

**Status:** Accepted (Phase 12).

## Context
The model call is the one step that fails for reasons we don't control — the network blips, the provider is
overloaded, the context overflows. A naive loop crashes the whole turn. We need to retry transient failures,
recover recoverable ones, and fail fast on fatal ones — without crashing or hammering a dead endpoint, and
without losing live token streaming (ADR-013).

## Decision
`llm/resilience.ts`:
- **`classifyError(err)` → `abort | overflow | transient | fatal`** — the crux (a should-retry table):
  abort (AbortError); overflow (message: context/num_ctx/exceeds); transient (ECONNREFUSED/RESET/EPIPE/
  ETIMEDOUT, HTTP 408/409/429/529/5xx, "fetch failed"); fatal (everything else, incl. 400/401/403).
- **`streamWithRecovery(make, opts)`** — an async generator wrapping the provider stream:
  - **happy path streams live** — each attempt calls `make()` (re-reads `messages`) and re-yields events; the
    UI's streaming view is transient and the final `message` is authoritative, so a re-stream self-corrects.
  - **transient** → exponential backoff `min(500·2^(n-1), 30s) + jitter`, up to `maxRetries` (4), then
    `RecoveryError`.
  - **overflow** → run `onOverflow()` (compact more aggressively) then retry — no backoff, no count — capped
    at `maxOverflowRetries` (2), then `RecoveryError`.
  - **abort** → rethrow immediately (checked before each retry and honored by the injected `sleep`).
  - `onRetry` callback (we log it to the trace); `sleep` injectable for deterministic tests.

Wired into the loop: the model call is `streamWithRecovery(makeStream, { signal, onOverflow: compact@0.6,
onRetry: trace })`. `onOverflow` reuses the Phase-11 compactor (reactive safety net for when the chars/4
estimate or Ollama's `num_ctx` was wrong).

## Consequences
- Ollama down / restarting (ECONNREFUSED), a transient 5xx, or a flaky socket → silent backoff+retry instead
  of a crashed turn.
- Context overflow → compact-then-retry: Phase 11 closes Phase 12's loop.
- Deterministic 400/auth errors fail fast with a typed `RecoveryError` (the session surfaces a clean message).
- Live streaming preserved on the happy path; a retry re-streams (transient flicker, corrected at `message`).
- Defer: per-model circuit breakers, model fallback ladder, retry-after header parsing (Ollama doesn't send
  one), foreground/background 529 distinction, persistent/unattended mode.

## Prior art
A typical production retry wrapper: the same taxonomy (a should-retry predicate), backoff `BASE 500·2^(n-1)`
cap 32s + jitter, honors `retry-after`, at most 3 retries on HTTP 529 → fallback model, overflow → adjust
`max_tokens`/compact (floor 3000), abort-aware `sleep`, a typed cannot-retry error. We distill the essentials
for a local-first, single-provider engine.
