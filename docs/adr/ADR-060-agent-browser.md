# ADR-060 — Agent-browser: visual verification + feature smoke tests (PLAN)

Status: **proposed** · 2026-07-20 · plan only — nothing built yet

## Context

Observed in a hosted app builder (user screenshot, Simmer rebuilt there): after coding, its agent
drives a real browser — starts the dev server, opens the app, reads an
**accessibility snapshot** (text tree: buttons, filters, empty-state), takes **screenshots** and
JUDGES them visually ("warm and beautiful with the terracotta and cream palette"), then **smoke-tests
the feature end-to-end** (opens the form, fills a sample recipe, verifies the list updates). Its
harness makes VISUAL and BEHAVIORAL decisions, not just compile-time ones.

Our definition of done stops at `npm run build` green. Run 5 shipped a working, good-looking app — but
nothing ever verified the app RUNS, looks designed, or that its one core flow works. The design-lint
asserts bundle text, not pixels; the verify gate asserts compilation, not behavior.

Enabler: `qwen36-agentic` reports `vision` in `/api/show` Capabilities (verified 2026-07-20), and our
provider already carries image content blocks on the native path. Gate: models WITHOUT vision must see
none of this (inert-by-default, the no-overfitting rule) — snapshot/interaction ops are text-only and
could stay available, but v1 gates the whole feature on vision to keep the matrix simple.

## Plan (phased; each phase independently shippable + measurable)

**Phase 0 — capability detection (tiny).** Extend ADR-038 detection to also read `/api/show`
`capabilities` → session exposes `modelCaps: { vision, tools, thinking }`. One `vision_probe` manual
check before building further: send one screenshot to the model ("describe this UI") and judge whether
its visual read is usable — a 36B's vision quality is the load-bearing unknown; if it can't see, stop here.

**Phase 1 — Browser tool, read-only (core + server).** New core tool `Browser` with ops:
- `open` — navigate to THE PREVIEW URL only (server injects it from PreviewManager; the dev server is
  already ours — the agent never starts its own, and external URLs are refused).
- `snapshot` — accessibility tree as text (cheap, structural: "is the filter bar there? is the empty
  state right?"). This is the DEFAULT op the skill teaches.
- `screenshot` — viewport → downscaled JPEG (~1024px, q70) returned as an image block for visual
  judgment. Budgeted: cap per session (~8) — every image is real prefill on a CPU-offloaded 36B.
Runs Playwright headless ON THE HOST against the published preview port (the sandbox container has no
browser; host Playwright hits localhost only). Advertised only when `modelCaps.vision && preview`.

**Phase 2 — interactions = smoke tests.** Ops `click` / `fill` / `press` targeting a11y refs from
`snapshot` (the observed loop: open form → fill sample recipe → save → snapshot-diff shows the new
card). Origin-locked to the preview URL. The skill gains the smoke recipe: one END-TO-END pass of the
app's PRIMARY flow, verified by snapshot (structure) + one screenshot (look).

**Phase 3 — harness wiring (detect→remind family).**
- `browser-smoke` skill: WHEN = after the check passes; the checklist (open → snapshot → primary-flow
  smoke → one screenshot judged against the design checklist → report PASS/issues).
- Verify-gate rung: build green + vision + preview running + Browser never used → ONE nudge: "the app
  compiles — now smoke-test it in the browser before finishing." Same once-per-submit + re-arm
  semantics as the todo gate.
- Planner: final plan step becomes "npm run build passes AND browser smoke of the primary flow".

**Phase 4 — measurement.** Eval assertion = the TRACE shows browser ops + a vision judgment + a smoke
pass (objective: events exist, flow steps executed); pixels stay un-asserted (screenshot diffing is
flake, the bundle design-lint remains the hard visual gate). A/B on builder-shop: does the smoke phase
catch runtime breaks the build misses (it did in the observed builder: empty-state, form flow)?

## Risks / costs
- Vision quality of the 36B is unproven → Phase 0 probe is the go/no-go gate.
- Image prefill cost on this box (CPU-offloaded weights) → snapshot-first discipline, screenshot cap.
- Playwright dep server-side (~50MB browsers) — already used in dev; pin + lazy-install.
- Flake: dev-server timing → reuse PreviewManager's wait-for-HTTP before `open`.

## Decision requested
Approve phases 0–1 to start (probe + read-only tool + skill), 2–3 after the probe verdict.
