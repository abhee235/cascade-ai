# ADR-080 — Hypothesis-driven runtime debugging (Cursor Debug Mode, Cascade-shaped)

Status: **Proposed** — phased; Phase 0 queued for next idle window, Phase 1 after the 3D-website milestone,
Phases 2–3 deferred until Phase 1 proves the loop.

## Context

ADR-079 gave the harness *senses* for game state (`__DEBUG__` + probe). The first live retest (trace
2026-07-26, Neon Breaker) showed the next gap up the ladder:

- The model DID reach for `probe` (the channel routes!) but tripped on JS-eval syntax (bare `{…}` object
  literal → `Unexpected token ':'`) — fixed in the skill (parenthesize) + an auto-paren tool fix queued.
- Turn 3, verbatim: *"I need to test the game interactively, but the Browser tool…"* — **eyes but no
  hands**: no click/press ops, so it couldn't even start the game it was told to tune.
- More fundamentally: probe reads *state you thought to expose*. A real bug hunt needs to observe
  **arbitrary functions' inputs/outputs at runtime** — the thing the user described: "add logs to all
  functions responsible, collect input and output, see the difference, analyse."

That is precisely the **debug mode** an AI code editor has published: (1) generate multiple hypotheses,
(2) the agent **instruments the implicated code with log statements** reporting to a local debug server,
(3) reproduce, (4) analyze the runtime logs against the hypotheses, (5) fix + verify, (6) **remove all
instrumentation**, leaving a clean diff. Runtime behavior becomes text, which LLMs are good at reading.

## Why Cascade can build this CHEAPER than Cursor did

Cursor needed a dedicated debug-server + extension endpoint to collect logs. Cascade's agent already owns a
live Playwright session into the page — so a **ring buffer on `window` + the existing probe op IS the
collector**. No new server, no new transport, no new protocol.

## Decision (phased)

### Phase 0 — hands + ergonomics (tiny; next idle window, server-code edits)
- Browser `probe`: auto-parenthesize expressions starting with `{` (kill the eval trap at the tool level).
- Browser gains **`click`** (selector or text) and **`press`** (key) ops — the missing hands. Needed by
  gametester ("click START GAME") and by any reproduce-by-interaction debugging. Playwright one-liners.

### Phase 1 — the manual-instrumentation loop (small; the Cursor shape, model-driven)
- **Template helper** (`src/lib/debugLog.ts`, template + skill-taught):
  `__LOG__(tag, data)` → pushes `{t, tag, data}` into `window.__LOGS__` (ring buffer, 500 cap) and
  optionally mirrors to console. Zero infra — probe reads `__LOGS__`.
- **`debug-runtime` skill** — the disciplined loop, exactly the published one:
  1. State 2–3 HYPOTHESES about the misbehavior (forces differential thinking).
  2. INSTRUMENT: use Edit to insert `__LOG__('fn.name', {args, result})` at entry/exit of the implicated
     functions only (not everywhere — hypothesis-directed).
  3. REPRODUCE: `probe "(__DEBUG__.start(), __DEBUG__.step(120), __LOGS__.slice(-50))"` — or click/press.
  4. ANALYZE: compare logged inputs/outputs against each hypothesis; the one the data kills is progress.
  5. FIX, re-reproduce, CONFIRM with the same probe.
  6. **CLEAN UP: remove every `__LOG__` line** (grep for `__LOG__` must return only debugLog.ts).
- The model inserts the logs with the Edit tool it already has — same as that editor's agent. No AST machinery.

### Phase 2 — automatic instrumentation tool (moderate; DEFERRED)
An `Instrument` tool: given a file + function names, mechanically wraps entry/exit with `__LOG__` via a
TypeScript transform (we already ship the TS compiler API for the LanguageService), and `Instrument
{restore:true}` reverts. Removes the model's manual-edit burden and guarantees clean removal. Build ONLY if
Phase 1 shows the model wastes significant turns hand-inserting/removing logs or leaves them behind.

### Phase 3 — `loganalyst` subagent (small; after Phase 1)
Read-only subagent (Browser+Read+Grep): pulls `__LOGS__`, correlates against the hypotheses, returns a
verdict + punch-list — keeping hundreds of log lines out of the main agent's context (smoketester pattern).

## Complexity verdict (the user's question)

Phase 1 is **not** too complex — it's a template helper + a skill, reusing Edit + probe; the hard part
(collector/transport) is free on our architecture. What IS premature: Phase 2's AST tooling, before we know
the model can drive the loop at all. Recommended order given current priorities: **3D-website work first**
(user's call), Phase 0 at the next idle server window (10 minutes), Phase 1 immediately before the next
game/debug-heavy session, Phases 2–3 on evidence.

## Success criteria (Phase 1, when it lands)
On a seeded behavioral bug (e.g. the too-fast projectile): hypotheses stated → ≤6 instrumented functions →
reproduce via probe → correct hypothesis identified from logs → fix confirmed by re-measure → `grep __LOG__`
clean. Turns spent should undercut the blind-churn baseline (19 edits on useGameLoop.tsx).
