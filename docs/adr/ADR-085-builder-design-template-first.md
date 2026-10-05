# ADR-085 — Builder design: one rebuilt template for every model, eyes and photos for everyone, freedom earned by the project

**Supersedes the Decision and Phases of ADR-083** (builder design quality). ADR-083's Context, research and
experiment evidence stay the record of *why*; this ADR is the only plan to implement. Sibling of **ADR-084**
(Cascade's own UI). Extends **ADR-057** (design system v2). Status: **proposed 2026-09-27**, branch
`builder-design-quality`. Nothing is implemented yet; each phase is proposed, explained and approved before
code, and every bench batch runs only on the user's go.

**Partly superseded by ADR-086 (2026-09-28):** the frozen block layer, the frozen lock, the frozen structural
library and recipes-as-the-lever are replaced by an open React template plus a blank "None" start chosen by
the user. This ADR's P0 instrument, P2 eyes, P3 photos and direction, the user-intent rule and `Restyle tune`
stand, as does the severity policy.

## Context — what the six-arm experiment measured (2026-09-27)

Same two scenarios for every arm (`builder-shop`: catalog → detail → cart → checkout; `builder-landing`:
the Ferrite SaaS page), same scaffold. Artifacts: `eval/design-review/adr083-ab/` (gitignored: sheets,
`summary.md`, `inputs/`, per-arm captures).

| Arm | Model | Environment | Result |
|---|---|---|---|
| 1 | gpt-6-luna (N=3) | Cascade template, as the product builds (bench had no Browser/ImageSearch) | All build; generic look; random photos (keyword host 401); footer on all shop pages 0/3 |
| 2 | gpt-6-luna (N=3) | Arm 1 + ui-ux-pro-max mandated | Loaded it 6/6, ran it 7×, applied nothing — visually = arm 1 |
| 3 | Claude Opus (N=1) | Free design + ui-ux-pro-max, verified photos, screenshot review | Best: polished, consistent (25 px width jump), footer everywhere, rich detail pages |
| 4 | gpt-6-luna (N=3) | Arm 3's brief + Browser (vision) + ImageSearch | Distinctive, correct photos, 3/3 footer — but 325–463 hard-coded colors, ~296 px width drift |
| 5 | Claude Opus (N=1) | Cascade template, arm-1 conditions | Looks like arms 1–2; shipped a runtime crash on the detail page it could not see |
| 6 | qwen36-agentic:latest, local 35B-A3B (3 builds) | Arm 4's conditions | Builds, uses tools, but does **not** author a design: default violet preset, skill never applied; 48 raw oklch colors outside the theme on its landing |

What it establishes:
1. **The template is the ceiling for everyone inside it** (arm 5 ≈ arms 1–2). For local users its look *is*
   the product's look.
2. **The environment beats the model**: freedom + eyes + real photos + a quality bar lifted Luna from arm 1
   to arm 4; taking them away dropped Claude from arm 3 to arm 5.
3. **Local models do not design when free** (arm 6) — freedom only helps a model that authors.
4. **Free design breaks the token system** (arm 4): raw colors and width drift that Restyle, dark mode and
   visual edit cannot reach.
5. **A skill alone changes nothing inside the template** (arm 2).
6. **Size is the wrong switch**: unknown for hosted models, misleading for an MoE (35B total, 3B active),
   blind to quantization (the user rejects the IQ3 quant at the same size).

Also found by the experiment and its critics (verified against the code):
- The frozen blocks carry bugs no model can fix: `Footer` renders links as `<span>`, `MediaCard` is a
  clickable `<div>`, `CartRow`'s remove is icon-only, `Hero layout="centered"` drops its media.
- `ui/button`'s `outline` variant paints `bg-background`, so an outline button on any colored band is
  white-on-white (arm 6's bug) — a kit-level fix, not a block fix.
- Chrome is taught per page (Footer "on landings"), so 40% of multi-page apps lose the footer on some pages.
- `frozenLayerHits` compares every project against the *current* template: changing any frozen file would
  flag every existing project as EDITED. Template changes need versioning first.
- Core's `mustRunBeforeDone` clears on any call of the tool, even one reporting problems — it cannot enforce
  a design gate; the server must.
- The shop bench checks hard-assert `preset: 'premium'` and `media-card`, contradicting subject presets.

## Decision

Cascade does **not** split design by parameter count or model id. Every model builds inside **one rebuilt
template**; the design decisions local models do not make move into **server code** (direction, preset,
photos, shared layout); every model gets **eyes** (a server-run design check) and **verified photos**; and
extra freedom is **earned by the project** — a project that holds a theme it wrote through `Restyle fork`,
complete and contrast-checked, gets `extend` latitude, whichever model wrote it. This keeps ADR-083's
anti-overfit rule ("activation is data; no model-specific branches") and the standing rule that switches
activate on evidence, never on a label.

| | `compose` — default, every project | `extend` — project holds a verified, stamped theme fork |
|---|---|---|
| Direction | Server resolves it from the planner's closed-choice brief + a seed from the project id; applies preset, photos and variant defaults before the builder's first turn | Same starting point |
| Theme | A subject preset from the menu; `Restyle {op:'tune'}`: colors the user names are taken exactly (P1), the model's own tweaks stay within curated ranges | Its own `src/themes/<slug>.css`, written by `Restyle {op:'fork', spec}` (every contract role in `:root` and `.dark`, contrast-solved, hash-stamped) |
| Layout | Recipe scaffold + frozen blocks; app components use tokens | Same; `src/components/site/` with block eject only if P6b is earned |
| Checks | TemplateAudit + server post-turn design check (objective classes HARD) | Same + HARD on raw colors outside `src/themes`, theme contract and stamp; a failed theme is reverted to the last good one |

Why the switch reads the project, not the model: every session gets the same tools and schemas (the prompt
prefix stays byte-stable for the KV cache); it is inert by default (a model that never forks never meets
the stricter checks); a bad fork is legible by construction and a broken one is reverted; and there is no
per-model verdict table to key on aliases, quants or digests. A capable model that never forks still gets
the rebuilt library, eyes and photos — it loses originality, never correctness.

### The user's explicit choices always win (added 2026-09-27)

The checks exist to catch what nobody chose (a crash, a blank page, a broken image, an unreadable button)
and to keep the *model's own* defaults consistent. They never argue with the person building the app:

- **A named color becomes a token, not an exception.** "Make it #FF5733", "our brand orange" → `Restyle
  {op:'tune'}` writes it into the theme: `--primary` (or `--accent`) takes the color exactly as given, and
  only its companions are solved — a readable `-foreground` (4.5:1), a dark-mode value, a matching `--ring`.
  The user's color is never shifted to pass a check. A token applies everywhere at once and survives dark
  mode; hard-coding does not (the P0 rescore: free Luna's raw colors kept 0/3 landing pages light in dark mode).
- **Where it lives:** NEW `src/themes/user.css`, created with its `@import` line (after the preset line) on
  the first tune. It layers the user's choices over any preset, survives `Restyle {op:'preset'}` swaps, and is
  removed only on request. It is theme, so the raw-color check never counts it.
- **A one-off the user insists on** ("this badge exactly #FFD700, nowhere else") may stay in the component
  with a `user-color` marker comment on the same line; the checks count it as *pinned*, never as raw.
- **No nudge argues with an explicit request.** Fix nudges fire only for the objective HARD classes; each
  one says "unless the user asked for this — then keep it and say so", and whatever remains is shown to the
  user, who can dismiss it.
- **Prior art draws the same line:** hosted builders auto-fix broken code as it streams, test and fix
  broken functionality in a browser, and route every color through semantic tokens.
  Automatic fixing is for what is broken; design language is a token system, never an error.

## ui-ux-pro-max and the other external skills: taken as data and checks, never installed at runtime

**Not installed in `packages/server/skills/`.** Measured: inside the template it was loaded 6/6 and applied
0/6 (arm 2); it needs Python (absent in the Docker sandbox and not guaranteed on desktop installs); its
keyword routing misroutes ordinary prompts ("online store" → Pharmacy, "SaaS landing page" → Link-in-Bio);
150/192 of its palettes are Tailwind defaults; its generated `MASTER.md` prescribes raw-hex CSS that fails
contrast and breaks dark mode; and even a local 35B given it with full freedom never applied it (arm 6).

What each source contributes instead (all MIT/Apache-2.0; ported data keeps its notice):

| Source | What we take | Where it lands |
|---|---|---|
| ui-ux-pro-max | Product-type → mood / avoid-list / section-order reasoning (no hex values) | `design/subjects.json` (P3) |
| ui-ux-pro-max | ~190 UX rules and the pre-delivery checklist | objective checks in `designChecks.ts` (P1–P2) |
| ui-ux-pro-max | 74 font pairings | research input for the preset faces (P3) |
| ui-ux-pro-max | 34 landing section orders | research input for recipes (P5) |
| ui-ux-pro-max | The "master file + page overrides" idea | `src/design.config.ts` + the plan's Direction line (P3) |
| frontend-design | Subject-grounded direction; the list of default looks to refuse | planner brief (P3); never-list checks and foundry intake (P1, P4, P6b) |
| web-interface-guidelines | Accessibility and polish rules | built into every block (P1, P4) and mechanical checks (P1–P2) |
| building-components | Component-authoring standard (cva, `data-slot`, a11y) | how *we* write blocks (P1, P4) — never shown to the builder |
| sleek | "Personality in color, type and imagery, not layout"; full-height review | preset/recipe design (P3–P5); capture method (P0) |

**Where the skills are used as skills: at development time.** They are installed globally for the
development-time coding agent (`~/.agents/skills`, linked into that agent's user skills directory). A
frontier model uses them when *we* author blocks, presets and recipes (P3–P5) and in the conditional foundry
(P6b). The bench's `--extra-skill` flag keeps
the vendored copy in `_temp/design-skills/` available as a research arm only.

## Architecture (real files; NEW = does not exist yet)

**A. One builder session for the product and the bench**
- NEW `packages/server/src/builderSession.ts`: `builderSessionOptions()` extracted from
  `ProjectManager.createSessionFor` (projectManager.ts), plus `runPlanStage()` and `runBuilderTurn()`, which
  today are duplicated between `scripts/eval/builder.mts` and `wsServer.ts`. The bench then gets exactly what
  ships — Browser (vision from an awaited `hasVision()`, not a hard-coded flag), ImageSearch, AI_RULES.md,
  the product's excluded tools. Allowed bench differences, listed explicitly: `autoMemory: false`, the
  scenario's `maxTurns`, the tracer, sampling.
- NEW `packages/server/src/designMetrics.ts`: one `page.evaluate` (same idiom as browserTool's audit) per
  view — blank detection, header/footer presence, **chrome** edges (content width is reported only), h1/h2
  sizes, broken images, 390 px overflow, computed contrast of text and buttons against their real background.
- NEW `packages/server/src/designChecks.ts`: source checks — raw colors in **every** notation (hex, rgb,
  hsl, oklch/oklab/lab/lch, `color()`, named) outside `src/themes`; glyph icons, `→` CTAs, `·` badges,
  real brand names used as fake customers, keyword photos in a Hero; `themeContract` (every role in `:root`
  and `.dark`, stamp); `themeContrast`; `themeDistance`. Dependency-free so plain-node `check.mjs` can use it.
  From P1, a color on a line carrying a `user-color` marker is counted as *pinned*, never as raw.
- NEW `scripts/eval/designCapture.mts` (the 09-27 capture script promoted: click flows from
  `contract.json`, 1440 + 390 px, light + dark; each view pass / fail / unreachable) and
  `scripts/eval/designRescore.mts` (re-scores kept workdirs; the adr083-ab workdirs are archived first).
- NEW `eval/design-review/{judge.mts,rubric.md}`: ADR-083's offline vision judge — report-only, calibrated
  against a human ranking of the six-arm sheets before any threshold uses it.
- NEW probe scenarios `eval/builder/builder-roastery` and `builder-dental` (no style adjectives), each with
  `check.mjs` and a `solution/` app. The shop checks' `preset: 'premium'` / `media-card` asserts become
  "the preset PLAN.md records" / `product-card|media-card` — a declared re-baseline in EVAL-BASELINE.md.

**B. The library (template rebuild, `packages/server/templates/react/`)**
- **Versioning before any frozen-file change:** NEW `frozen.lock.json` (sha256 of every variant of every
  frozen file ever shipped, including retired skins); `frozenLayerHits` (auditTool.ts) accepts any of them;
  NEW `.cascade/template.json` stamps each project's kit version, and instructions, skills and probes are
  served for that version. An "upgrade kit" migration is a later, explicit user action.
- **Kit and block fixes:** `ui/button` outline → transparent (fixes white-on-white on any band); `Footer`
  links as `<a>`/`<button>`; `MediaCard` → `<article>` with a stretched button; `CartRow` text "Remove";
  `Section` gains `id` and `header='left|centered|split|none'` (eyebrow opt-in); `Hero centered` renders
  media; `CTASection` actions as data with a NEW `inverse` Button variant; `Photo` stamps its load state.
- **Token contract additions** in `src/index.css`: `--content-w`, `--inverse(-foreground)`,
  `--font-display`. Contract test: NEW `packages/server/test/themeContract.test.ts`.
- **NEW blocks:** `SiteLayout` (NavBar, optional `AnnouncementBar`, `<main>` at `--content-w`, Footer —
  rendered once by the scaffold `App.tsx`), `ProductCard` (required `price/image/onOpen/onAdd`),
  `ProductDetail`, `TrustStrip`, `CategoryTiles`, `OrderSummary`, `FeatureRows`, `ImageBand`, `LogoCloud`
  (fictional wordmarks), `Footer variant='rich'` (visible photo credits), Hero `editorial|showcase|
  product-mock|stacked`.
- **Presets:** each gets its own display face (4 of 6 share Geist today); +4 subject presets (warm-organic,
  clinical, outdoor-rugged, dev-tool dark) → 10 now, 12 target; OFL latin-subset woff2 ≤120 KB per preset.
- **Skins retired** with every dependent (restyle check, restyle demo, parity suites, gallery); their hashes
  stay in the lock.
- NEW `src/design.config.ts` (per-project variant defaults, frozen, hash-verified) read through a
  `DesignConfigProvider`; NEW `recipes/<category>/<recipe>/` (pre-wired `App.tsx` on `SiteLayout`, one file
  per view, small per-section seed files); NEW `demo/GalleryMatrix.tsx` (every variant × preset, light and
  dark, 1440 and 390 px, automated contrast/overflow/broken-image checks; humans judge taste).

**C. Direction, resolved by the server**
- `agents/builder/planner.md`: the Design line becomes closed choices — `category`, `productType` (~40),
  `recipe`, `mood`, `hero`, `signature`, `avoid`; `planQualityIssues` validates the enums.
- NEW root `packages/server/design/` (`subjects.json`, `compose-card.md`, `photo-library/`), added to the
  desktop build (`packages/desktop/build.mts`, `packaging.test.ts`) in the same batch.
- NEW `src/direction.ts` → `resolveDirection(brief, seed)`: pure; seeded from the project id; picks within
  the top 3 allowed options per subject; the user's own words (a named preset or color) win.
- NEW `applyPlanDesign()` inside `runPlanStage()`: `setPreset()`, generate `design.config.ts`,
  `photoResolve()`, copy the recipe on a fresh project, write one Direction line into PLAN.md.
- NEW `src/photoResolve.ts`: per-product searches (ImageSearch backend) + NEW `verifyImage()` (HEAD 200 and
  `image/*`), seeded pages and dedupe, written to `src/data/photos.ts` (never PLAN.md — 2,500-char pin cap);
  offline fallback to `design/photo-library/` (~60 CC0 images). The `ImageSearch` tool returns only verified
  URLs. `photoFor()`/`photo()` read the resolved photos first, so existing prompts land on them unchanged.

**D. Verification: eyes for everyone, enforced by the server**
- `runBuilderTurn()` runs the design check after each builder submit; remaining HARD findings get up to 2
  bounded fix nudges (findings at the tail, KV-safe); anything left is reported honestly as red.
  `packages/core` does not change.
- One factory in `browserTool.ts` builds `Browser` (NEW `op:'design'`) and NEW `DesignReview`, sharing the
  page and the 8-screenshot budget. Views are reached by click flows from NEW
  `skills/builder/{commerce,landing}/contract.json` (accessible names: 'Add to cart', a header 'Cart…',
  'Checkout'); unreachable is reported, never counted as a failure.
- **Severity:** HARD from day one only for objective classes — a reached view that is blank, a runtime
  error, a broken image, invisible interactive text (<1.5:1). Everything else (contract probes, full 4.5:1
  contrast, footer coverage, chrome drift, repeated section headers) stays SOFT until it shows 0 false
  positives on the gallery, the kept adr083-ab apps and traces.
- Images are attached only when there are findings, as fixed-scale crops; their token/time cost on the
  local model is measured first. Text-only models still get every objective check through the DOM.
- NEW `design/compose-card.md` (≤1,000 chars) is pinned before PLAN.md within one ≤3,500-char pin budget.

**E. Latitude and the foundry**
- NEW `src/presetGen.ts`: a brand spec → contract CSS for `:root` and `.dark`, contrast solver (4.5:1 text,
  3:1 non-text), hash stamp. Backs `Restyle {op:'tune'|'fork'}` in every session. Its first slice ships in
  P1 with `tune` (a user color → the role, its solved foreground, dark value and ring, into
  `src/themes/user.css`); P6a extends it to whole forks.
- Severities keyed on the project (`extend` when the active theme is a stamped fork that verifies); no model
  registry fields.
- NEW `scripts/foundry/harvest.mts` (development-time only, conditional P6b): strong models with the
  external skills produce candidate themes/components; every candidate passes the never-list and gallery
  review before it enters the library.

## Phases (ordered by impact per effort; one batch and one eval per phase)

Standard bench cells: `qwen36-agentic:latest` (primary, local), `gpt-6-luna` (strong-model no-regression),
`qwen3.5:9b` (integrity floor only); scenarios {shop, landing, roastery, dental}; N=3. A 27B joins once one
is pulled at an acceptable quant and timed. Comparisons pool across scenarios: ≥5/6 blind pairs plus at
least one objective metric moving the same way; the judge feeds thresholds only after calibration; N=1
claims are labelled.

| Phase | Deliverables | Acceptance (N=3) | Effort |
|---|---|---|---|
| **P0 — Measure + oracle go/no-go** | `builderSession.ts` (options, plan stage, builder turn); designMetrics/Checks/Capture/Rescore; judge + calibration; roastery/dental probes; fixture re-baseline; `--design-seed`; image-cost probe on Qwen; fragility of arm-4's raw colors under Restyle/dark measured | Rescore reproduces the 09-27 numbers exactly (hex 325/463, Qwen oklch 48, footer 0/3 vs 3/3, arm-5 blank page); parity baseline table in EVAL-BASELINE.md. **Oracle:** Qwen A (parity template) vs B (+ arm 3's finished theme) vs C (+ its design brief), shop + landing — **GO** if B or C beats A in ≥5/6 pooled pairs with an objective metric agreeing and 0 crashes | ~7 days + 1 approved bench |
| **P1 — Versioning, correctness, chrome, default-rules removed** | Frozen lock + kit stamp; `ui/button` fix; block fixes; `SiteLayout` + `--content-w`; inverse surface; `applyPlanDesign()` v1 (applies PLAN's preset); verified ImageSearch; skins retired; skills drop two-tone / default eyebrows / "one primary CTA" / "copy the reference page"; one imagery rule everywhere; chrome taught app-wide; HARD invisible-text check; the user-intent rule: `Restyle {op:'tune'}` + `src/themes/user.css` + the `user-color` marker | Footer on all views 6/6; chrome drift ≤4 px; 0 invisible-text / CTA-band contrast failures; footer links are anchors; cards keyboard-reachable; built preset = PLAN preset 100%; 0 broken ImageSearch images; builds not down; an old-kit project iterates with 0 EDITED findings; a user-named color lands as a token in 3/3 probe prompts (0 raw copies, exact value kept, foreground ≥4.5:1 light and dark, survives a preset swap) | ~8 days |
| **P2 — Eyes for everyone** | Browser/DesignReview factory, `op:'design'`, contract flows, post-turn check with ≤2 nudges, crops on findings, Done line, inert `design-reviewer` agent | 0 blank/crashed/broken-image views left at done; arm-5's blank page and Qwen a2's broken image caught on replay; 0 false positives on the HARD classes; Qwen wall time within +15% of P1 | ~6 days |
| **P3 — Subject direction, preset faces, resolved photos** | Planner brief + validation; `design/` shipped in desktop; `subjects.json`; `direction.ts`; `design.config.ts`; 6 presets refitted + 4 subject presets; `photoResolve.ts` + offline library | Preset matches the subject in ≥5/6 roastery/dental runs, never defaulting to premium for a subject it doesn't fit; verified hero photo ≥11/12 online; offline shop builds with 0 broken images; PLAN.md ≤2,500 chars 12/12; ≥3 distinct presets across scenarios | ~7 days |
| **P4a / P4b — Structural library** | 4a commerce: ProductCard, ProductDetail, TrustStrip, CategoryTiles, OrderSummary, AnnouncementBar, rich Footer. 4b landing: FeatureRows, ImageBand, LogoCloud, Hero and Section variants. Harvested from arms 3/4, ported to tokens + cva, never-list checked, gallery-approved | GalleryMatrix 0 contrast failures, 0 overflow at 390 px; 0 missing Add to cart; detail pages ≥3 bands; repeated section headers −50%; judge hierarchy/rhythm/polish up for every model, no objective regression | ~5 + 5 days |
| **P5 — Recipes + design skill v3** | 5 recipes with per-section seed files, `verifyRecipes.mts`; `scaffoldFromPlan()` (fresh projects only); design SKILL v3 ≤2k tokens incl. its reference list; compose card pinned; skills consistency test | Qwen turns −30%, tokens in −40% vs P4; requirement slips = 0; mandatory design context ≤2k tokens; compactions not up; 9B integrity holds | ~7 days |
| **P6a — Theme fork for every session** | `presetGen.ts` extended to whole forks (`Restyle {op:'fork'}`; `tune` shipped in P1), stamp verification, project-keyed severities, post-turn revert; bench-only `--no-fork` | 200 random brand specs → 0 contrast failures light and dark; session options identical across models; hand-edited theme reverted; fork vs no-fork: no objective regression | ~4 days |
| **P6b — Foundry + site latitude** *(only if some model's forked output clears the bar below)* | `src/components/site/` with block eject; `harvest.mts` | ≥1 foundry batch certified; no regression | ~3 days |
| **P7 — Optional designer role** *(only if P6a shows forks beat compose)* | An explicit user setting `designer: {provider, model}`: a strong model writes the brand spec and direction, the local model builds offline | Off = byte-identical to the resolver path; on: judge ≥+1.0, raw colors ≤5, drift ≤4 px, hosted cost ≤$0.10/app | ~5 days |

**The bar for more latitude (research only, never a runtime switch)** — per model and scenario, N=3:
0 crashed/blank views and 0 broken images; raw colors outside `src/themes` ≤5 per app; chrome drift ≤4 px;
footer on every view; theme passes the contract in light and dark; `themeDistance` from the nearest shipped
preset above threshold in ≥2/3 runs; calibrated judge ≥+1.0 over the same model's `compose` arm and ≥9/12
blind pairs; minutes ≤1.5× compose. Nothing clears it today: Luna free fails discipline, Claude's N=1 fails
the contract (no dark theme).

## What we deliberately do not do

- Tier by parameter count, family, provider or model id — no verdict table, no demotion, no verdict UI.
- Ship "free design" as a product default.
- Install or run ui-ux-pro-max (or any external design skill) in the product; import its hex palettes; load
  Google Fonts at runtime.
- Unfreeze `blocks/` or `ui/`; change `packages/core`; make the judge a gate.
- Ask the model to undo a color, font or look the user explicitly asked for, or shift a user's color to pass
  a check.
- Tune for the 9B or anything below it; change the builder-shop fixture prompt (baseline stays comparable).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| One template look becomes N recipe looks | Seeded top-3 picks per subject; rotated header/hero/band variants; photo variety tracked; the foundry keeps adding recipes |
| Kit changes break existing projects | `frozen.lock.json` accepts every shipped variant; per-project kit stamp; explicit upgrade migration with rollback; an old-project check in P1 |
| New checks fire on correct work (ADR-057's one-CTA lesson) | Only objective classes start HARD; everything else SOFT until 0 false positives |
| A check fights a deliberate user choice | User-named colors become tokens (`tune`, P1); one-offs carry a `user-color` marker counted as pinned; nudges fire only on the objective HARD classes, each says "unless the user asked for this", and what remains is shown to the user, who can dismiss it |
| Probes cannot reach a view | Click flows by accessible name; unreachable is reported, never a failure |
| The oracle says NO-GO | Stop before P3–P5; P1 and P2 are worth shipping regardless |
| Vision is expensive on the local GPU | Images only on findings, as crops; cost measured before the budget is set |
| Photos: outages, licensing, brands | HEAD + content-type checks, per-product seeded queries, visible credits, offline CC0 library; brand-bearing product photos remain a known, unchecked risk |
| KV-cache churn | Nothing resolved per model; identical tool schemas; Direction and config written before turn 1; findings at the tail |
| Server edits kill a running build | Check for a live turn before each edit batch; every bench batch approved by the user |

## Consequences

- **Better:** local and strong models both start from a designed, subject-grounded app with correct photos
  and one shared layout; runtime crashes, blank pages and invisible buttons are caught before "done"; the
  bench finally measures the product as shipped.
- **Costs:** ~49 working days for P0–P6a (P0–P3 ≈ 28 deliver every correctness fix and most of the
  local-model gain); a larger library to certify (GalleryMatrix automates correctness, humans judge taste);
  font bytes per preset; longer bench runs.
- **ADR-083** keeps its Context, research and experiment record. Its Principles stand, with Principle 1
  amended: taste lives in code we author *or certify*, and a project may carry its own theme when written
  through `Restyle fork`, contract-complete and stamped — earned by the project, never granted by model id.
  Its Target becomes "the 27B/35B-A3B class". Its phases are replaced by the table above.

## First three tasks (P0)

Each is explained before any edit, stays within 100 lines per edit, and is left uncommitted for review.
Before touching `packages/server/src`, check that no build or bench is running.
1. **Extract `builderSessionOptions()`, `runPlanStage()`, `runBuilderTurn()`** into
   `packages/server/src/builderSession.ts`; rewire `projectManager.ts`, `wsServer.ts`, `builder.mts`. Proof:
   a snapshot test shows the product's session options unchanged and the bench's differences exactly the
   allowed list.
2. **Build the instrument** (`designMetrics.ts`, `designChecks.ts`, `designRescore.mts`) and prove it
   reproduces the 09-27 numbers exactly before trusting it on new runs. No model run needed.
3. **Build the oracle seed**: finish arm 3's themes by hand (add `.dark`, map its extra tokens, bundle the
   fonts), add `--design-seed`, re-baseline the shop checks. Then propose the oracle bench (Qwen A/B/C ×
   shop/landing × N=3, 18 runs, ~4.5–6 h) for approval.

## P0 progress (2026-09-27)

**Task 1 — one builder session (done, uncommitted).** `builderSession.ts` now defines the builder session
options, the planner session, the plan stage and one builder turn; `projectManager.ts`, `wsServer.ts` and
`builder.mts` call it. The product's options are unchanged (pinned by `test/builderSession.test.ts`); the bench
may differ only in `autoMemory` and `maxTurns`. **Declared re-baseline:** the bench's template arms now get
Browser, ImageSearch, AI_RULES.md, the product's excluded tools, the `'auto'` output cap and a sandboxed
planner, so bench numbers from here on are not comparable with the 09-27 ones.

**Task 2 — the instrument (done, uncommitted).**
- `designChecks.ts` (pure, importable from plain-node `check.mjs`): raw colors in every notation outside
  `src/themes` (token-derived `var()` / `from var()` forms excluded); the never-list (glyph icons, arrow CTAs,
  `A · B · C` meta strings, real-brand customer walls, keyword/random photos, the hero case named);
  `themeContract`, `themeContrast`, `themeDistance`, `nearestPreset`. The fork stamp joins `themeContract`
  with presetGen (P6a), which defines what the stamp hashes.
- `designMetrics.ts`: one in-page expression per view — the 09-27 fields verbatim, plus blank, site-chrome
  container edges, broken images, overflow, and contrast against the background actually painted under the
  text (element stack + canvas compositing). Text over a photo, gradient text, fading reveals and disabled
  controls are reported as unknown, never guessed.
- `scripts/eval/designCapture.mts` (light 1440 = the 09-27 pass; dark 1440; light 390; each view reached or
  unreachable) and `scripts/eval/designRescore.mts` (`--verify`). The click flows live in designCapture for
  now; P2 moves them to `contract.json` with the rest of the contract flows.
- **Proof:** re-scoring the 25 kept 09-27 runs reproduces **783/783** recorded fields and **190/190** summary
  cells. The new every-notation counter agrees: landing hex **463**, Qwen landing **48** oklch; shop hex
  **327** (the two extra are 8-digit alpha colors the 09-27 regex could not see). Footer on all shop views:
  0/3 template vs 3/3 free, as recorded. Arm 5's detail page: `runtime error: r is not a function` + blank;
  its cart is **unreachable** (09-27 counted it as a second blank page).
- Vetting the new columns on the kept apps corrected four definitions before they could mislead, each now a
  regression test: the site chrome is found by geometry (generated apps wrap the page in `<main>`); drift uses
  container edges (a cart badge moved the header's content 24–36 px); punctuation-only text is exempt from
  contrast; a brand wall needs standalone brand items near a customer word (a pricing tier's "Slack, Linear
  & GitHub" is not a customer claim).

**What the instrument already shows on the 09-27 apps (P1 inputs, not yet acted on):**
- HARD classes: arm 5's crash, Qwen shop-a2's broken Flickr image, Qwen landing's invisible "Talk to Sales"
  (1.02:1, the outline-button bug). Every other reached view passes.
- Cart views overflow at 390 px by 104–163 px in 3 of the 6 template shops (arms 1–2) and in Claude's free
  shop; two free landings overflow too (Claude 10 px, Qwen 117 px).
- Preset contrast (30 pairs each; `primary` and `destructive` are held to 4.5:1 AS TEXT, because the template
  paints eyebrows, links and form errors with them): all six presets fail dark `destructive-foreground` on
  `destructive` (2.8–3.4:1); luxe-dark's and playful's light `primary` fails as text (3.1–3.8:1), playful's
  button label too (3.72:1), luxe-dark's ring (2.67:1). The CTA band's secondary text on primary fails in
  aurora-glass (3.84:1) and minimal-mono (4.01:1).
- Dark mode does not reach free Luna's raw colors: 0/3 landing and 4/12 shop views stay light. Arm 3 has no
  dark theme at all (0 of 26 dark roles; 0/5 views go dark), which is task 3's work.
- The six presets sit ΔE 3–9 apart (their neutrals are nearly identical); arm 3's themes are ~32 from the
  nearest one.
- Nothing sweeps `eval/.work` (the bench deletes only its own current workdir), so the kept runs are safe in
  place and the archive step is optional. Artifacts: `eval/design-review/adr085-p0-rescore/` (gitignored).

**Task 3 — the oracle seed (done, uncommitted).**
- NEW `eval/design-seeds/{builder-shop,builder-landing}/` (tracked, so the oracle is reproducible): arm 3's
  themes finished to the contract — `theme.css`, bundled OFL fonts with their licenses (Nunito Sans + Rubik
  66 KB; IBM Plex Sans + JetBrains Mono 86 KB; Fontsource 5.3.0), `DESIGN.md` (1,055 / 1,112 chars),
  `seed.json`. Each theme header records its translation: arm 3 used `--accent` as its CTA, so the CTA color
  moves to the template's CTA role, `--primary`, and `--accent` takes arm 3's own neutral wash; the extras
  that have no role yet are dropped (the ink bands wait for P1's inverse surface); `.dark` is new.
- `primary` must also read as TEXT in the template (see the preset finding above). Arm 3's fill colors did
  not (orange 3.4:1 on mint, red 3.0–3.7:1 on slate), so each seed takes the nearest tint that does both
  jobs — the shop's orange one step deeper with the white label arm 3's own brief specified; Ferrite's red is
  arm 3's own text tint (`--accent-text`, #f87171) with a dark label.
- Proof: both themes pass the contract and all 30 contrast pairs, light and dark (every shipped preset fails
  at least one). Installed into each scenario's reference solution, the real check passes and the built CSS
  carries the seed; every captured view (shop 12, landing 3: light, dark, 390 px) has 0 contrast failures,
  0 invisible CTAs, 0 broken images and 0 overflow. ΔE to the nearest preset: 12.8 (shop), 30.3 (landing).
- `builder.mts --design-seed eval/design-seeds [--design-brief]` (logic in `scripts/eval/designSeed.mts`,
  tested): installs before `createSession`; C's brief rides in AI_RULES.md, the product's channel for a
  project's rules; PLAN.md's `preset:` is pinned after the plan stage; each row records the pin, the built
  preset and whether the seed was kept. A drift back to premium fails the re-baselined shop check; the
  landing check stays `'*'`, so there the row's `kept: false` is what excludes the run.
- Fixture re-baseline done and declared in EVAL-BASELINE.md: the shop checks assert the preset PLAN.md
  records and accept `product-card|media-card`; `--verify` sound for both shop scenarios.
- **Caveat on the Context's claim 3:** the 09-27 Qwen arm ran at the bench's default temperature 0 (greedy),
  which Qwen's card forbids for these MoEs and which this repo has measured degrading them. The oracle runs
  Qwen at its own tune (temperature 0.6, presence 0.5), so its A arm also re-tests that claim.

**The oracle (run 2026-09-27, user-approved; Qwen at its own tune, 18 runs, ~5.7 h incl. an 80-min hang).**
- Builds: each arm failed one (A: an unresolved import; B and C: the build crashed). The seed survived in every
  run that built (5/5 B, 5/5 C). Among runs that built, the bench check passed 5/5 A, 4/5 B, 4/5 C (B and C
  each missed one required block: FAQ, NavBar).
- Objective: no crashed or blank views, no broken images or raw colors in any arm; landing contrast failures
  per view 1.5 (A) → 0.7 (B) → 0.5 (C); footer on every view: shop 0/3, 0/3, 1/3; landing 2/3, 3/3, 2/3. B's one
  HARD failure was the `ui/button` outline bug on a CTA band (dark-on-dark, 1.0:1).
- The user's review of the blind pairs: the themes look great, the structure does not — uneven spacing, thin
  bands, the same logo every time. Measured (ADR-086 Context): gaps 52–294 px on one page; Claude's polished page
  has equally large gaps but dense sections; logos are a 16 px stock icon (`Store` in 8/9 shops). **Verdict: a
  better theme lifts the local model's output, and the structure is the ceiling** — the next lever is layout
  freedom (ADR-086), not more presets. Blind picks remain optional (they calibrate the judge).
- The bench hang: the product's Browser tool leaves its dev server and headless Edge running after a run, so
  `builder.mts` never exited (80 min lost before a watcher unblocked B and C). Fix pending: tear both down per
  run, and check whether the product leaks the same per session.

**Still open in P0:** the judge and its calibration, the roastery/dental probes, the image-cost probe on Qwen,
the Restyle half of the raw-color fragility measurement, and the parity baseline table in EVAL-BASELINE.md
(the oracle's A arm is that baseline).

## References

ADR-083 (context, research, experiment), ADR-084 (Cascade's own UI), ADR-057, ADR-054, ADR-055, ADR-056,
ADR-060, ADR-071, ADR-082; EVAL-BASELINE rungs 9 and 11. Experiment artifacts and the full panel plan:
`eval/design-review/adr083-ab/` (gitignored; `implementation-plan.md`, `summary.md`, sheets, `inputs/`).
