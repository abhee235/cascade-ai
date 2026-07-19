# ADR-058 — Live-lock breakers: read-loop gate, unconsumed-read shield, mid-flight check nudge, todo drop guard (+ 128K window)

Status: accepted · 2026-07-19

## Context — the measured failure (Simmer live session, builder-2026-07-19-14-13-32.jsonl)

53 turns / 58 min. The app was fully written by turn 18 (8 Writes). Every turn after was ONE bug the
model never fixed: it had hand-typed a `PhotoName` union in `types.ts` with 14 invented keys that don't
exist in `photos.ts`. It diagnosed the mismatch correctly at least six times, re-read the same three
files five times each, rewrote its todo list 12 times — and issued **zero Edits** and **zero
`npm run build` runs** in the entire session. Its own words (turn 40): *"I've been circling because my
file reads keep getting compacted before I can act on them."* Turn 50 shows compaction amnesia: it
attributed its own turn-18 files to "a prior session".

The mechanism is a stable orbit, not a stall — so none of the existing gates could see it:

- **Compaction cadence beat the model's decide→act latency.** 16 compactions in 53 turns at a 32k
  window. The flat recency shield (`keepRecentResults 5`) is often shallower than ONE multi-read turn
  (the model issues up to 7 parallel reads), and the masking horizon (`keepRecentTokens` ≈ 6k) spans
  ~2–3 turns — while this model's read→narrate→todo→act cycle spans 3–5. Reads expired before the act;
  every re-read raised pressure, triggering the next masking pass.
- **The terminal gates (ADR-049/051 verify, todo gate) never fire while tools keep being called.** A
  live-lock never goes terminal. Different failure class → different detectors.
- **Root defect enabler:** nothing forbade re-declaring another module's type, so the drift was possible
  at all.

## Decisions (all detect→remind idiom — ADR-034/049/050 family — plus one data change)

1. **Read-loop gate** (`agent/readLoopGate.ts`, wired in `agentLoop.ts`): per-file successful-read
   counters; a successful Write/Edit of the file resets its counter (the read was consumed). The 3rd
   read with no intervening mutation injects an act-now `<system-reminder>` ("make the Write/Edit as
   your FIRST tool call"), once per crossing (a later mutation re-arms). Paged reads (offset/limit,
   ADR-052 bites) count per page so chunk-walking a big file never trips it. Only in loops whose
   registry can mutate (explore subagents re-read legitimately). Trace: `read_loop`.

2. **Unconsumed-read shield** (`context/compactionLayers.ts` `unconsumedReadIds`, merged into the
   compactor's shield): additionally shield the LATEST read of each file not Written/Edited since —
   "the read the model hasn't acted on yet" is the true working set, which the flat last-N shield
   under-protects. Bounded by design: cap 3 files, 16-message horizon (a reference file read early —
   `photos.ts` — must not block the summarize boundary forever), and never in survival mode (survival
   beats recency, unchanged).

3. **Mid-flight check nudge** (`agent/verifyGate.ts` `STALLED_VERIFY_TURNS = 5`): after 5 consecutive
   turns in unverified-edit state, inject the check directive ONCE per submit, naming the declared
   command (`npm run build`). Compiler output is compaction-PROOF ground truth — it arrives as a fresh
   tool result and re-derives everything the masked reads knew. Trace: `stalled_verify`.

4. **TodoWrite dropped-item guard** (`tools/builtins/TodoWrite.ts`): full-list replacement stays (the
   standard semantics), but the tool now diffs the incoming list against the stored one and NAMES vanished
   pending/in_progress items in its result (normalized + substring-tolerant matching so rephrasing
   doesn't false-positive). Warns, never rewrites — the store stays exactly what the model sent.

5. **Skill rule — one owner per type** (architecture + design skills): types owned by another module
   are IMPORTED, never re-declared; concretely `import type { PhotoName } from '@/lib/photos'`, names
   come from the reference, never from memory. Kills the root defect class, not just this instance.

6. **Window raised to 128K** (`qwen36-agentic` Modelfile `num_ctx 32768 → 131072`, model re-created;
   static map + tests updated — detection via ADR-038 `/api/show` remains the ground truth). At 131072
   the plan becomes: reserve 20k → effective ~111k → auto-compaction ~100k → masking horizon ~27k
   tokens — the cadence that caused the orbit essentially disappears for builder-sized sessions.
   Trade-offs to watch: 128k lands in the `full` prompt tier (richer system prompt), KV cache is much
   larger (possible VRAM offload), and prefill grows with fill level (~650 tok/s ⇒ minutes per turn
   near 90k) — the gates above still matter because they shorten sessions, window or not.

## Amendment (same day, 128K retest submit-2): the todo gate RE-ARMS

The retest validated the window fix (0 compactions/44 turns, 7 Edits, 7 build runs) but exposed a
budget gap: the model spent the todo gate's once-per-submit charge on a turn-0 conversational stop,
burned both verify strikes on turns 2–3, then — after a failed garbled-args Edit — went terminal
**thinking-only** at turn 7 ("Let me fix data.ts and then build the remaining views", zero visible
text, zero tools) and the spent gates let the session end. Not an Ollama failure: zero transport
errors in the trace. Fix: any successful tool call since the last firing RE-ARMS the todo gate (a
silent stop after real work is a NEW event), capped at 3 firings per submit; and when the terminal
follows a FAILED call, the gate names it ("your last tool call FAILED — Edit: …") so the retry is a
concrete instruction. Test: watchdog.test.ts "TODO GATE re-arms after successful work".

Second finding (submit 3): success-only re-arming was one nudge short — the gate fired, the model
COMPLIED with a TodoWrite whose args were corrupted (presence-penalty degradation, see ADR-059), the
call FAILED, and the next silence was accepted. A failed attempt is compliance, not stonewalling: ANY
tool attempt now re-arms (the firings cap keeps it bounded). Test: "a FAILED attempt also re-arms".

## Verification

18 new tests (`readLoopGate.test.ts`, `unconsumedReadShield.test.ts`, `todoDropGuard.test.ts`) — unit
folds + through the real loop/compactor; full suite 375 green. Product proof pending: re-run the Simmer
brief and compare turns-to-done, Edits vs re-Reads, compaction count, and whether any gate fires.
