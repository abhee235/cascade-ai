---
name: game-dev
description: Build games and canvas/animation apps that FEEL right, not just compile — the debug contract (window.__DEBUG__), probe-driven tuning with real numbers, and deterministic simulation. A canvas is invisible to snapshots and static in screenshots; this skill is how you SEE your game.
whenToUse: Load BEFORE writing any game, canvas, physics, sprite, particle, animation-loop (requestAnimationFrame), arcade, or 3D/three.js code. Also when the user says a game "feels wrong", too fast/slow, unfair, or janky.
---
# Game dev — you cannot tune what you cannot measure

The build passing means the LOGIC compiles. It does not mean the ball bounces right, the projectile speed is
sane, or the pause actually pauses. You cannot see a canvas: accessibility snapshots return NOTHING for it,
and a screenshot is one frozen frame — motion, speed, and collision are invisible in both. (Measured: a full
Breakout build made 17 Browser calls and learned nothing about gameplay; it shipped a projectile ~3× too
fast because it was tuning blind.)

The fix is the same trick real game engines use: a **debug interface**. Expose the game's state as data,
then MEASURE with `Browser {op:"probe"}` instead of guessing.

## 1. The __DEBUG__ contract — REQUIRED before any gameplay code

Create `src/game/debug.ts` FIRST and wire it into your game loop:

```ts
// Exposes the running game to the harness. Ship it enabled — it costs nothing and makes the game tunable.
export function exposeDebug(game: {
  state: () => object            // full snapshot: mode, score, lives, entities with x/y/vx/vy
  step: (frames: number) => void // advance the SIMULATION n fixed frames while paused (deterministic)
  seed: (s: number) => void      // seed the RNG so runs are reproducible
  start: () => void              // enter PLAYING from any state — probes can't click your START button
}) {
  const events: object[] = []
  const push = (e: object) => { events.push({ t: performance.now(), ...e }); if (events.length > 200) events.shift() }
  ;(window as any).__DEBUG__ = { state: game.state, step: game.step, seed: game.seed, start: game.start, events, push }
  return push // call push({type:'collision'|'death'|'powerup'|'transition', ...detail}) at every notable event
}
```

Rules:
- `state()` must include every moving entity's **position AND velocity** (x, y, vx, vy) plus mode/score/lives.
- Call the returned `push` at every collision, death, pickup, and state transition — this is your flight recorder.
- `step(n)` advances the fixed-timestep simulation WITHOUT rendering or real time — it is what makes
  behavior measurable and deterministic. If your loop is delta-time-based, run `n` fixed 1/60s ticks.

## 2. Probe-driven tuning — numbers, not vibes

`Browser {op:"probe", expr:"..."}` evaluates JS in the live page and returns JSON. The tuning loop:

```
Browser {op:"open"}
Browser {op:"probe", expr:"__DEBUG__.state()"}                          → verify shape, note positions
Browser {op:"probe", expr:"(__DEBUG__.step(60), __DEBUG__.state())"}    → exactly 1 simulated second later
```

Probe syntax rules (JS eval gotchas — these WILL bite otherwise):
- An object literal MUST be parenthesized: `({ phase: __DEBUG__.state().mode })` — a bare `{...}` is parsed
  as a block statement and throws `Unexpected token ':'`.
- Multiple steps: comma expressions in parens — `(__DEBUG__.seed(42), __DEBUG__.step(60), __DEBUG__.state())`.
- The game may need STARTING before there is anything to measure: expose `start()` in the contract (below)
  and probe `(__DEBUG__.start(), __DEBUG__.step(60), __DEBUG__.state())` — never assume a human clicked.

Speed = Δposition over 60 stepped frames = **px/second**. Compare against these bands (1280×800 canvas):

| Thing | Feels right | Too fast above |
|---|---|---|
| Player projectile | 400–700 px/s | 900 |
| Ball (breakout/pong, initial) | 250–400 px/s | 550 |
| Paddle / player move | 500–800 px/s | 1000 |
| Enemy walker | 80–200 px/s | 300 |
| Falling pickup | 120–250 px/s | 350 |

If a measured speed is outside its band: fix the CONSTANT, re-probe, confirm the number — never eyeball it.

## 3. Units policy — the #1 cause of "way too fast"

Express ALL speeds as **px/second** and multiply by `dt` each tick (`pos += v * dt`). NEVER px/frame:
px/frame is monitor-dependent (a 144Hz player gets a 2.4× faster game) and unmeasurable. If you catch
yourself writing `x += 8` per frame, stop and convert (`8 px/frame @60fps` = `480 px/s`).

## 4. Behavior assertions — run these probes before calling the game done

```
step(120) twice → ball.x/y changed both times            (game actually advances)
ball near wall → step until past → vy or vx flipped      (bounce works; no tunneling through walls)
events after play: some {type:'collision'}               (collisions detected, not just drawn)
score before/after brick events → increased              (scoring wired)
mode:'PAUSED' → state(), wait 2s real time, state()      (identical = pause truly freezes; no time-jump on resume)
positions are finite numbers, never NaN                  (NaN = a physics bug that renders as "disappearing")
seed(42) + step(300) twice from reset → identical state  (determinism — required for reproducible bug reports)
```

## 5. Structure that keeps games tunable

- Fixed-timestep simulation (accumulator pattern) + render interpolation; `step()` drives the same tick fn.
- One `CONFIG` object holding every speed/size/rate constant — tuning = editing one file, re-probing.
- Game-state machine (`START/PLAYING/PAUSED/OVER`) with transitions pushed to `__DEBUG__.events`.
- Canvas at a fixed logical resolution, scaled to fit — probes and bands stay meaningful at any window size.
- Cleanup on unmount: cancel the RAF loop, remove listeners (StrictMode double-mount must not double-run).

## 6. Delegate the full pass

For a thorough check that keeps probe output out of your context:
`Subagent {agent: "gametester", prompt: "<what the game is + its intended mechanics/speeds>"}` — it probes
every assertion above, measures speeds against the bands, and returns a GAME REPORT punch-list to fix.

## 7. The screens AROUND the game

A game is a phase machine with four screens, and scaffolded games ship only the middle one. Every game
needs: a MENU (Hero centered — title, one-line rules, ONE start button, best score visible), a
layout-stable HUD (StatCard row whose slots never appear/disappear mid-game), a GAME-OVER showing the
run's numbers with restart AND back-to-menu, and a persistent top-5 LEADERBOARD (localStorage,
EmptyState when fresh). The full working set, verbatim:
`Skill {name: "game-dev", file: "reference/pages.md"}` — copy its phase-union SHAPE
(`menu | playing | gameover`), wrap your own mechanics in it.
