# ADR-061 — Slow-prefill-aware stall watchdog: probe, don't guess

Status: accepted · 2026-07-20

## Context — the watchdog killed legitimate work at the finish line

A cold first turn on a big existing project must prefill the whole history from scratch (~65k tokens ≈
**~3 minutes** on the CPU-offloaded 36B — hardware, not a bug; see the EVAL-BASELINE prefill verdict).
The stall watchdog fires at 180s of stream silence — so it aborted the prefill just before the first
token, and at the 2nd "transient" it **recycled the model, destroying the very KV cache the prefill had
been building**, restarting cold. Measured live (smoke-test trace): 4 recover() events, a one-time
3-minute cost turned into 10+ minutes of churn, the UI reading as dead.

The conflation: "no events yet" has two different meanings —
- **pre-first-token**: almost always a big prefill cooking (the backend is fine), and
- **mid-stream**: a generation that STOPPED — the crashed/hung-backend case the watchdog exists for.

## Decision — ask the backend instead of raising the timeout

A blind bigger timeout would slow real crash detection for everyone. Instead, evidence:

- `ModelProvider.alive?()` — cheap liveness probe. Ollama's `/api/tags` is served by the HTTP layer and
  answers **even while a generation runs**, so `true` during pre-first-token silence means "busy
  prefilling", not "dead". Bounded (5s), never throws.
- `streamWithRecovery`: when the stall timer fires **before the first event**, call `alive()`:
  - alive → keep waiting on the SAME pull (capped by `firstEventMaxMs`, default 600s), yielding a
    synthetic `slow_prefill` event — the loop traces it and tells the user the truth ("Large prompt —
    the model is still reading it (312s)…").
  - dead/unknown/cap-exceeded → `StallError`, exactly the old path (retry → recycle).
- **Mid-stream stalls are NEVER extended**, even with a live backend — unchanged semantics.
- Event-loss guard: the pull promise SURVIVES stall verdicts (`raceStall` races an existing promise);
  abandoning a pull and calling `next()` again would queue a second pull and silently eat the event the
  first one resolves with.
- `completeWithRecovery` (summarize/curation) deliberately keeps its flat 300s deadline: its measured
  failure was a body-hang WITH a healthy backend (iterate-7) — an alive-probe extension would reopen
  that exact 40-minute hole.

Explicitly rejected: overriding the user's Ollama `keep_alive` to make cold starts rare — the backend's
idle policy belongs to the user's environment, not to Cascade (their call, per review).

## Verification

4 watchdog tests: live-backend prefill waited out (zero retries, `slow_prefill` visible), dead backend
stalls as before, `firstEventMaxMs` caps the patience, mid-stream stall never extended. Suite 404 green.
Product proof pending: reopen a big project after idle — expect one honest ~3-minute first turn with
"still reading" status, zero recover() churn, then instant warm turns.
