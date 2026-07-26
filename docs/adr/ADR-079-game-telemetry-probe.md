# ADR-079 — Game telemetry: the __DEBUG__ contract + Browser `probe`

Status: Accepted — implemented 2026-07-26

## Context

The Neon Breaker build (measured 2026-07-25) proved a sensory gap: the model wrote game logic that compiled
and ran, but tuned *behavior* blind. A `<canvas>` is **invisible to accessibility snapshots** (all 17 Browser
calls returned an empty tree around it) and a screenshot is one frozen frame — motion, speed, and collision
cannot be observed through either. Churn concentrated exactly in the gameplay math (`useGameLoop.tsx` ×19),
and the shipped game had a projectile ~3× too fast — the model had no channel to *perceive* what it was
tuning. The harness pattern that fixed type errors (push compiler feedback; ADR-075) has a runtime sibling:
give the model **senses for dynamic behavior**.

## Decision

Make the game observable as **data**, since it cannot be observed as pixels:

1. **Browser `probe` op** (`browserTool.ts`): `{op:"probe", expr}` evaluates a JS expression in the live
   page (Playwright `page.evaluate`) and returns the JSON result (4k cap; page-side throws come back as
   self-correcting errors pointing at the contract). Read-only, no screenshot budget consumed.
2. **`game-dev` skill** (`skills/builder/game-dev/SKILL.md`) — loaded on game/canvas/physics/3D triggers:
   - **The `__DEBUG__` contract, REQUIRED before gameplay code**: `state()` (every entity with pos+vel),
     `events` ring buffer (collisions/deaths/transitions — the flight recorder), `step(n)` (advance the
     fixed-timestep simulation deterministically), `seed(s)`.
   - **Probe-driven tuning**: speed = Δposition over `step(60)` = px/second, compared against feel-bands
     (projectile 400–700, ball 250–400, player 500–800, enemy 80–200, pickup 120–250 px/s @1280 logical).
   - **Units policy**: all speeds px/SECOND × dt — px/frame is monitor-dependent and unmeasurable (the
     root cause of the too-fast projectile class).
   - **Behavior assertions**: advance, bounce (velocity sign flip), collision events, scoring, pause
     freeze without resume time-jump, no-NaN, seeded determinism.
   - Structure: fixed-timestep + accumulator, single CONFIG for constants, state machine, fixed logical
     resolution, unmount cleanup.
3. **`gametester` subagent** (`agents/builder/gametester.md`): read-only (Browser/Read/Glob/Grep) QA pass
   that probes the full assertion list, measures every entity against the bands, and returns a numeric
   GAME REPORT punch-list — keeping verbose probe output out of the builder's context (smoketester pattern).

## Consequences / validation

- The Neon Breaker "projectile too fast" class becomes measurable: probe → 1240 px/s vs band 400–700 →
  fix constant → re-probe. Numbers, not vibes.
- Validation plan: re-run the game prompt with the skill live; the tell is probes appearing in the trace,
  speed constants converging in ≤2 iterations, and the shipped game landing inside the bands.
- Tests: probe op happy path/JSON shape, no-expr + not-open errors, page-throw contract hint
  (browserTool.test.ts). Skill/agent load via the existing dirs (no registration code).
