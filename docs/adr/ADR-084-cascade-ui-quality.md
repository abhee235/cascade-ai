# ADR-084 — Cascade's own UI: fix tokens before pages, and make the audit a check

Sibling of **ADR-083** (builder design quality) and its exact complement: 083 is about the apps Cascade
**builds**; this is about the app Cascade **is**. Touches **ADR-081** (the Observatory surface) and
**ADR-057** (design system v2, whose "concrete over prose" lesson applies again). Status: **implemented
2026-09-27**, branch `builder-design-quality`. Phases 0–6 are done; the measured outcome and the
corrections implementation forced on the plan are in *Implementation record* at the end.

## Context

**The review (user, 2026-09-27).** After installing five external design skills globally
(`frontend-design`, `canvas-design`, `web-design-guidelines`, `vercel-composition-patterns`,
`ui-ux-pro-max`), the ask was to audit **Cascade's own web UI** against the ui-ux-pro-max rubric — not
generated apps. A first pass reviewed only the builder route and generalised from it; the user pushed back
("we have observatory, we have models, we have projects, other tabs as well"), and all six routes were then
measured. **The correction changed the conclusion**, which is the main reason this is an ADR and not a
checklist.

### Method (recorded so the numbers are reproducible — and so the traps are not re-sprung)

- Live audit of the running dev UI (`localhost:5319`, ws server on `4319`), **light** theme, 2560×1249,
  driven through Playwright. Source sweep by grep for what the DOM cannot show.
- **Contrast must use a real OKLCH→sRGB conversion.** Tailwind v4 emits `oklch()`; `getComputedStyle`
  returns it verbatim and **canvas does not normalise it**. A naive `rgb()` parse silently yields
  `ratio = 1.0` for *every* pair. Two consecutive passes in this session produced exactly that, and both
  looked like a catastrophic finding ("15 contrast failures"). Only a sanity assertion caught it.
  **Any audit script MUST assert that `contrast(#fff, #000) === 21` and that a known `oklch()` pair
  resolves**, and refuse to report if either fails.
- **Focus visibility must be tested with a real `Tab` press.** Programmatic `.focus()` never triggers
  `:focus-visible`, which produced a false "0 of 40 controls show focus" reading. Under a real Tab,
  `:focus-visible` matches and an outline renders.

These two traps are load-bearing: an unguarded audit script reports fabricated failures, and the
fabrications are more alarming than the real defects.

### What the evidence says (measured 2026-09-27)

| Route | text nodes | <12px | contrast fails | controls | <24px |
|---|---|---|---|---|---|
| `/` home (dark) | 12 | 0 | 0 | 12 | 1 |
| `/projects` | 136 | 0 | 1 | 92 | 13 |
| `/chats` | 136 | 0 | 1 | 90 | 13 |
| `/mcp` (Connectors) | 43 | 0 | 1 | 42 | 13 |
| `/settings` | 44 | 0 | 2 | 39 | 13 |
| `/observatory` | 68 | **29 (43%)** | **6** | 43 | 13 |
| `/project/<id>` (builder) | 238 | **27** | 1 | 161 | **71** |

**1. The type scale is intact; two surfaces broke away from it.** Projects, Chats, Connectors and Settings
sit on a clean 12/14/16/24 ramp with **zero** sub-12px text. All the tiny text is in two dense surfaces:
Observatory (29 of 68 nodes at 11px) and the builder (21 nodes at 10px, 6 at 11px, 138 of 238 at 13px).
This is **not** a design-system failure and must not be treated as one — the remedy is to bring two screens
back to the ramp, not to redesign the ramp.

**2. One component fails contrast on all six pages.** `New project` measures **3.3:1** against a 4.5
requirement (WCAG SC 1.4.3). It lives in the persistent sidebar, so it is one defect counted six times —
the highest-leverage fix in the app, and it is the primary CTA.

**3. Only the SEMANTIC colours fail.** `Connected` = **2.46:1** (Settings); `1 failed` / `2 failed` =
**3.82:1** (Observatory). The neutral palette is excellent — 237 of 238 text nodes pass on the builder.
The success/error tokens were never contrast-checked, and this is the worst place for it: **status is
exactly what must be readable**, and on Observatory the failing text is the failure indicator itself.

**4. Observatory inverts its own hierarchy.** Conversation rows run the **full ~2,340px** for a single
line — roughly 250+ characters against a 65–75 optimal measure, with no `max-width`. The widest, boldest
element on each row is the *prompt text*, which is near-identical across rows; the genuinely distinguishing
data (project, model, duration, failure count) sits bottom-left at 11px and 3.82:1. **The least
distinguishing content receives the most visual weight**, and ~60% of the viewport below the list is dead
space.

**5. Truncation without disambiguation, in three places.** Recent projects (`Build 'Northline Supply', a …`
twice; `can you please create a t…` twice), Observatory rows, and the model picker (`hf.co/unsloth/Qw…`
vs `hf.co/unsloth/Q…`). No date, no differentiator, no tooltip — items distinct in the data are
indistinguishable on screen.

**6. Hit targets: 13 systemic + 58 local.** Every page reports exactly 13 controls under 24×24 (WCAG 2.2
SC 2.5.8) — the persistent sidebar/status chrome, one component counted six times. The builder adds ~58
more, for 71 of 161.

**7. What only the source sweep sees** (`packages/web/src`, 51 components): `prefers-reduced-motion`
appears **twice in the entire codebase**; **14** raw hex colours bypass the tokens; **7** `outline-none`
occurrences have no `focus-visible`/ring replacement in the same file (the live Tab test shows focus does
render, so these are latent, not active — audit individually, do not mass-edit).

**8. What is already right, and must not regress.** Focus rings present and correctly `:focus-visible`
scoped; **160 of 161** interactive elements carry an accessible name; zero emoji-as-icons (lucide SVG
throughout — an explicit ui-ux-pro-max anti-pattern, avoided); colour is never the sole signal (`1 failed`
pairs red with text; the status dot pairs colour with the word `local`); both themes exist; and Settings is
the model page — section headers, label + description + value, a segmented runtime control, and the
cleanest ramp in the app.

## Decision

### Principles

1. **Tokens before pages.** Two token fixes (CTA, semantic status) clear contrast failures across all six
   routes. No page-level edits until the tokens are right.
2. **Do not redesign what measures clean.** Four of seven routes have zero typography defects. Scope the
   work to Observatory, the builder, and the shared chrome.
3. **Checks over prose** — the ADR-057/ADR-083 lesson applied to ourselves. A rule in a style guide drifts;
   the audit becomes a test that fails.
4. **The audit script is a deliverable, not scaffolding.** It carries the two sanity assertions above, or it
   will fabricate findings (see Method).

### Phases

- **Phase 0 — the check.** A repeatable UI audit (Playwright + the OKLCH-correct contrast function + the
  real-Tab focus probe) that emits the per-route table above, with a self-test that aborts unless
  white-on-black is 21:1 and a known `oklch()` pair resolves. Record the baseline.
- **Phase 1 — token contrast.** `New project` 3.3 → ≥4.5; the semantic status pair (`Connected` 2.46,
  failure red 3.82) → ≥4.5, in both themes. Largest win per line changed.
- **Phase 2 — hit targets.** Raise the 13 shared-chrome controls to ≥24×24 (SC 2.5.8) via padding/hit-area,
  not icon size, so visual weight is unchanged.
- **Phase 3 — return the two dense surfaces to the ramp.** Observatory's 11px and the builder's 10/11px
  labels move onto 12/14/16. Keep 13px body if it is deliberate; retire it if it is drift (open question 1).
- **Phase 4 — Observatory layout.** A `max-width` measure on row text; promote the distinguishing metadata
  above the repeated prompt; reclaim the vertical dead space.
- **Phase 5 — truncation.** One shared "distinguish, don't just truncate" treatment (middle-ellipsis, or a
  secondary line carrying date/model) for recent projects, Observatory rows and the model picker.
- **Phase 6 — motion and source hygiene.** A `prefers-reduced-motion` policy; audit the 7 `outline-none`
  sites individually; move the 14 raw hex values onto tokens.

### Non-goals

- Redesigning the visual language. The system is coherent; this is remediation, not a restyle.
- Any change to the generated-app template or builder skills — that is ADR-083's subject, and the two must
  not be conflated in one branch.

## Consequences

- Phases 1–2 change shared components, so every route is touched by a few lines — review the audit diff per
  route, not per component.
- The Phase-0 script needs a running UI, so it is opt-in (like the existing live suites), never part of the
  default `vitest run`.
- Changing the semantic palette alters every status surface, including generated-app previews rendered
  inside Cascade chrome. Both themes must be checked.

## Validation plan

- Phase 0 establishes the baseline table; every later phase re-runs it and must improve its target metric
  with **no regression** in the others.
- Contrast is pass/fail against WCAG AA (4.5 normal, 3.0 large); targets against SC 2.5.8 (24×24).
- Dark theme must be measured for Phases 1 and 3 — this audit covered light for the inner routes and dark
  only for `/`.
- A human pass confirms Phase 4 actually reads better; a ratio cannot see hierarchy.

## Open questions

1. Is 13px body in the builder deliberate (VS Code parity) or drift? It decides Phase 3's scope.
2. Should the audit also run against the packaged desktop app, or the dev server only?
3. Does the semantic palette need a separate on-surface variant per theme, or does one adjusted pair serve
   both?
4. Observatory: is the prompt the right row title at all, or should a row lead with project + model?

## Limits of this audit (explicitly not covered)

Dark theme on the six inner routes; responsive/narrow widths; keyboard traversal beyond a single Tab; the
model picker popup (reviewed visually, not measured); the Code/Terminal/Versions panes inside the builder;
motion behaviour of any kind.

## Files (by phase, when approved)

- **0:** a new `scripts/ui-audit/` script plus its self-test; baseline recorded in `docs/EVAL-BASELINE.md`.
- **1:** `packages/web/src/index.css` (token definitions) and the CTA component.
- **2:** `packages/web/src/components/layout/NavSidebar.tsx` and the shared status/chrome components.
- **3:** `packages/web/src/pages/ObservatoryPage.tsx`, `packages/web/src/components/chat/*`,
  `packages/web/src/components/builder/*`.
- **4:** `packages/web/src/pages/ObservatoryPage.tsx`, `packages/web/src/components/observatory/*`.
- **5:** the recent-projects list, `ObservatoryPage.tsx`, `packages/web/src/components/ModelManager.tsx`.
- **6:** `packages/web/src/index.css`, the 7 `outline-none` sites, the 14 raw-hex sites.

## References

- ADR-083 — builder design quality (sibling: generated apps, not this app).
- ADR-081 — desktop shipping + storage ports (introduced the Observatory surface audited here).
- ADR-057 — design system v2 ("only as strong as its most concrete example — and its checks").
- ui-ux-pro-max priority table (P1 accessibility, P5 layout, P6 typography, P9 navigation) — the rubric used
  for scoring; installed globally at `~/.agents/skills/ui-ux-pro-max`.
- WCAG 2.2 SC 1.4.3 (contrast), SC 2.4.7 / 2.4.13 (focus), SC 2.5.8 (target size).

---

## Implementation record (2026-09-27)

### Outcome

| Metric | Baseline | After | Note |
|---|---|---|---|
| Sub-12px text nodes | 29 | **0** | 38 `text-[10px]/[11px]` classes raised to `text-xs` |
| Contrast failures | 6 | **0** | identical in light AND dark |
| Controls with no accessible name | 59 | **0** | |
| Controls under 24×24 (effective) | 78 | **11** | 7 drag rails + 4 log rows; both documented exceptions below |

`vitest run` 1127 passed / 0 failed; typecheck clean. Audited light and dark, six routes plus the builder.

### What implementation proved the analysis had wrong

1. **The CTA contrast was not a token value — it was a function bug.** `theme.ts:contrastFor()` derived
   `--primary-foreground` from the user's accent using a *threshold* (`lum > 0.6`) on *non-linearised* sRGB
   channels. For the shipped Green preset it returned white at **3.296:1** when black was available at
   **6.01:1** — matching the measured 3.3 exactly. It therefore failed only for users who had chosen an
   accent, which is why a clean browser profile never reproduced it. Fixed by comparing real ratios;
   `packages/web/test/accentContrast.test.ts` now asserts every preset ≥4.5 and sweeps the colour cube for
   "never pick the worse foreground".
2. **There were no semantic status tokens to fix.** Status was written with raw palette utilities. The hex
   grep that found "14 raw hex" missed them entirely: **76** `text-<colour>-<shade>` utilities were in use.
   35 carrying success/warning/danger meaning were migrated to new `--success`/`--warning`/`--danger`
   tokens; the rest (chart/diff/brand hues) were left deliberately.
3. **The light/dark split is forced, not stylistic** — answering open question 3. AA requires text
   luminance **≤ 0.1833** on the light ground and **≥ 0.1887** on the dark one. No single value can serve
   both, so the tokens are defined per theme.
4. **"13 shared-chrome controls" was one component × N projects**, not a fixed 13: one "Delete project"
   button per recent project. Root cause was upstream shadcn's `after:absolute after:-inset-2
   md:after:hidden` — a hit-area expander switched off above the mobile breakpoint, leaving 20×20 on
   desktop. Removing one modifier fixed every instance without changing a painted pixel.
5. **13px body is deliberate** (open question 1): 138 of 238 builder nodes use it consistently, VS Code
   parity. Phase 3 was scoped to the 10/11px outliers only.
6. **`prefers-reduced-motion` was partly handled already** (the two bespoke keyframes), and **most raw hex
   is legitimate** (10 are xterm.js theme colours — a canvas widget that takes a JS object, not CSS; 2 are
   the brand gradient). Phase 6 shrank accordingly: a global policy covering Tailwind's `transition-*`,
   with `animate-spin` preserved because it is the only signal that a turn is running.

### The audit script was wrong three times before it was right

Phase 0's value was mostly in what it caught about *itself*. Each of these produced confident, plausible,
false findings:

- **oklch parsed as rgb** → every ratio exactly `1.0`, reported as "15 contrast failures". Caught by the
  white-on-black sanity assertion, which is why that assertion aborts the run.
- **Programmatic `.focus()`** → "0 of 40 controls show focus". `:focus-visible` only engages on real input.
- **`getBoundingClientRect()` vs `elementFromPoint()`** → the box cannot see an `::after` hit area
  (under-credits fixes), and `elementFromPoint` returns null outside the viewport (marks every off-screen
  control as too small — 32 phantom failures on a scrolled log). The final probe expands the box by the
  pseudo-element's insets and only point-tests what is on screen.
- **Focus indicated on an ancestor** via `focus-within` read as MISSING on the composer, and nearly earned
  it a second, redundant ring. The probe now diffs the ancestor chain focused vs blurred.

**The harness also caught a regression it had itself motivated.** Widening the sidebar drag rail from
`w-4` to `w-6` to satisfy SC 2.5.8 pushed its `z-20` edge over the per-row delete buttons and swallowed
their clicks — 12 controls per page became unreachable. Reverted. A 16×1000 drag handle is trivially
acquirable; a stolen delete button is not.

### Accepted exceptions (not defects)

- **The sidebar drag rail** (16×1000, one per route). Widening it demonstrably breaks an adjacent control.
- **Four builder log rows.** They are ≥24px tall and fail only because the adjacent icon's expanded hit
  area takes one corner of their 24×24 probe box. The probe deliberately stays strict — that strictness is
  what caught the rail regression — so these are recorded rather than engineered away.

### Follow-ups this surfaced (not in scope here)

- `ObservatoryPage` still has substantial vertical dead space with few conversations.
- The remaining ~41 non-status raw palette utilities (chart/diff/brand) deserve a deliberate decision.
- The audit runs against the dev server only (open question 2 remains open).
