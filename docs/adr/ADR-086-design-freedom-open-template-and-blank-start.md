# ADR-086 — Design freedom by default: an open React template and a blank ("None") start

**Status:** proposed 2026-09-28, branch `builder-design-quality`. **Supersedes** ADR-085's Decision on frozen
blocks ("one rebuilt template of frozen blocks for every model; freedom only for a stamped theme fork") and
the plans built on it (the frozen lock, the frozen structural library, recipes as the main lever). **Keeps**
ADR-085's instrument (P0), eyes (P2), photos and direction (P3), the user-intent rule and `Restyle tune`, and
its severity policy (only objective classes HARD).

## Context — what the oracle and the rescore showed (2026-09-27/28)

- **The oracle** (Qwen A template / B + a designer theme / C + its brief; shop + landing, N=3): each arm
  failed one build, and the seed survived in every run that built (5 of 5 in B, 5 of 5 in C). Objective numbers moved
  toward B/C (landing contrast failures per view 1.5 → 0.7 / 0.5; footer coverage up slightly); B's one HARD
  failure was the known `ui/button` outline bug. The user's review: **the themes look great; the structure
  does not** — uneven spacing, empty-looking bands, the same logo in every app.
- **Spacing, measured.** The blocks set vertical space three ways at once: theme tokens (Section 64–80 px,
  Hero 96 px), hard-coded values (PageHeader `pt-10 pb-8`, LogoStrip `py-5`, CTASection `py-12`, Footer
  `py-14`) and none (BentoGrid, FeatureGrid, FAQ, Testimonial, PricingTable rely on a Section wrapper). The
  content-to-content gap between sections on one page runs **52–294 px (up to 5.4× apart)**. ui-ux-pro-max
  uses one scale with one section step — 48 px standard, 64 px spacious, hero 64/96 px — so the template's
  gaps are 2–4× even its *spacious* setting, and uneven.
- **"Void" is density, not the gap.** Claude's free-design landing (arm 3, the one the user called polished)
  has gaps just as large (158–322 px), but every section is dense with subject-specific content: the product
  itself as the hero (a live incident table), code and terminal panels, a stats row, split layouts. The
  template's blocks produce thin bands under one scaffold (eyebrow + heading + grey line): a row of empty
  logo boxes, a mostly blank "94%" tile, a narrow centered FAQ.
- **The logo** is whatever the model passes to NavBar's `brand` slot: a 16 px stock icon and the name —
  `Store` in 8 of 9 shops, `Rocket` in 4 of 9 landings.
- **The ceiling is the structure.** The same Claude produced the best design free (arm 3) and a look-alike of
  every template app inside it (arm 5).
- **The user's product call:** design freedom by default; a blank "None" start in the new-chat template
  dropdown, where attached images are read first and planned from; local models may need follow-ups to finish;
  iterate on gpt-6-luna (Qwen is too slow for the loop).

## Decision

1. **Two starting points, chosen by the user** in the new-chat dropdown — never by model id: **React** (the
   open template, default) and **None** (a blank project).
2. **The React template is open.** Nothing is frozen. The blocks become a *pattern library* — examples the
   model copies and adapts — and `ui/` stays the shadcn kit, editable as shadcn intends.
3. **Discipline moves from frozen code to tokens and checks.** Color, type, radius and spacing come from the
   theme; the objective checks stay HARD (blank view, runtime error, broken image, invisible CTA) and the rest
   SOFT (raw colors outside the theme, contrast below AA, rhythm, never-list). This keeps what broke when Luna
   designed freely on 09-27 (hundreds of raw colors; dark mode never reached its pages) under control while the
   layout goes free.
4. **One spacing system, ui-ux-pro-max's model:** a density dial per theme sets `--section-gap` and
   `--hero-pad`; exactly one element owns a band's vertical padding (the section); adjacent same-tone sections
   do not double up; and a **density rule** — every section carries a visual anchor (product visual, data or
   image), sparse bands take the compact step.
5. **A logo system:** a `Logo` pattern with real forms (monogram, wordmark in the display face, icon in a
   shape), chosen for the subject; never a bare 16 px stock icon.
6. **None (blank)** gets its own builder profile: a planner that designs from scratch (reading attached images
   first on vision models) and a builder brief — distilled from the 09-27 free-design arm — that picks the
   stack (default Vite + React + TypeScript + Tailwind), defines the design tokens in one theme file, installs
   its dependencies, and keeps the preview contract (`npm run dev -- --host --port <p>` serves the app).
7. **Images reach the planner for every template**, not just None: the plan stage's first round gets the
   first message's images; a text-only model is told images were attached that it cannot see.
8. **Iterate on gpt-6-luna;** Qwen runs only as an approved confirmation batch.

The user choosing the start keeps ADR-083/085's rule that nothing is keyed on a model's size or id.

## Architecture (real files; NEW = does not exist yet)

- **Web** (`packages/web`): `HomePage.tsx`'s template Select gains "None — design from scratch"; the Home
  prompt box gains image attachments (reusing `ChatPanel.tsx`'s attachment code), and `store.startBuild` carries
  them with the pending first message.
- **Server:** `templates.ts` lists `none` as a start with no files; `ProjectManager.create()` records the start
  in the project record and stamps NEW `.cascade/template.json` (`{ "template": "react" | "none", "kit": … }`,
  the per-project stamp ADR-085 planned), which the session builder reads.
- **`builderSession.ts`:** `builderSessionOptions()` picks the profile from the stamp — *react-open*
  (`frozenPaths: []`, the builder skills and planner) or *none* (NEW `skills/builder-free/`,
  `agents/builder-free/planner.md`, a free-design BUILDER_BEHAVIOR). The parity test covers both profiles.
  `runPlanStage()` gains the first message's images.
- **Open template** (`templates/react`): frozen paths removed; the blocks stay as editable examples; spacing
  tokens (`--section-gap`, `--hero-pad`, the density dial) in `index.css` and every preset; Section owns
  vertical padding; NEW Logo pattern; design skill v3 teaches composition (rhythm, density, split layouts,
  visual anchors, logo). TemplateAudit's frozen-layer check retires with the frozen layer.
- **Instrument:** `designMetrics.ts` gains `rhythm` (the content-gap sequence, max/min) and a `logo` probe
  (the brand mark's size and kind) — reported, SOFT.
- **Bench:** `builder.mts --template react|none` (none = an empty workdir, `npm install` allowed); the
  research-only `--free-brief` retires into the product's None profile.

## Phases (each proposed and approved before code; one Luna batch per phase)

| Phase | Deliverables | Acceptance (gpt-6-luna, shop + landing, N=3) |
|---|---|---|
| **P0 — the None start** | Dropdown option; Home image attach; stamp + profile; free planner + brief; images to the plan stage; bench `--template none` | 6/6 build and serve via the dev contract; PLAN.md written before code; with a reference image attached (a probe), the plan names palette, type and layout taken from it; 0 HARD failures |
| **P1 — the open React template** | Unfreeze; spacing system + density rule; Logo pattern; design skill v3; rhythm metric | Content-gap max/min ≤ 2× (today 1.8–5.4×); ≥ 3 distinct logo forms across 6 apps; blind pairs vs today's template ≥ 5/6; no objective regression (raw colors outside the theme ≤ 5/app, AA contrast, 0 HARD) |
| **P2 — local confirmation** | One approved Qwen batch on both starts; follow-up rounds to "done" counted | No HARD regression vs the oracle's A arm; the rounds a local model needs are reported, not gated |

ADR-085's P2 (eyes and the post-turn check) and P3 (photos and direction) continue after P1, for both starts.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Weak models without frozen blocks write broken or uneven layouts | HARD checks + follow-ups; measured in P2. If Qwen regresses, the React start may offer a *guided* mode as a user setting — never a model-id switch |
| Free design breaks tokens (Luna, 09-27) | One theme file in both starts; raw colors outside it reported; dark mode checked by the capture's dark pass |
| None-projects vary in stack and can break the preview | The dev-server contract is in the brief and verified (the preview must answer) |
| None needs `npm install` (offline desktop) | React stays the default and works offline; None reports a failed install plainly |
| The pattern library drifts from the kit | Patterns are examples, not imports; the checks judge the result, not the file tree |

## What we deliberately do not do

- Choose the start or the freedom level by model size or id.
- Remove the React template, or make None the default.
- Install or run ui-ux-pro-max in the product (its spacing and density model is adopted as design data).

## P0 progress (2026-09-28)

**Built (uncommitted), all tests green (1,193 at the last full run):**
- Server: the `none` start in `templates.ts`, stamped in `.cascade/template.json` at creation;
  `ProjectManager.create()` makes a blank project (a .gitignore, the stamp, a baseline commit). `builderSession.ts`
  picks the profile from the stamp — `BUILDER_BEHAVIOR_FREE` shares the React rules by reference (the React text
  is byte-identical, pinned by hash), nothing frozen, ApplyPack/TemplateAudit/Restyle off. The plan stage takes
  the first message's images (only on a model with vision; a text-only model is told). `planQualityIssues` is
  start-aware: a blank plan's Design section must carry a hex palette and both faces.
  `ensureVisualEditConfig` no longer overwrites a blank project's own vite config.
- Content: `agents/builder-free/planner.md` (images first; Stack section; Design as a direction) and
  `skills/builder-free/{design,architecture}` — they shadow the React versions by name; the generic skills are
  inherited, the category skills are used for their contracts only.
- Web: "None — design from scratch" in the Home dropdown, image attachments on the Home prompt, sent with the
  first message. Driven in the running app: options, hint, chips, removal — no page errors.
- Bench: `builder.mts --template none` (an empty workdir; the model installs its own dependencies) and
  `--images`; the scenario checks skip template assertions for a blank project; the rescore handles blank
  projects (its theme file is the theme, the React contract is n/a).

**Measured so far (gpt-6-luna):** the smoke run and the first batch run — a blank shop — both passed the check in
~6 min, with a real logo mark, a split hero with a photo, one content width and a coherent palette. Weak spots
seen: "system sans" instead of a type pairing, two all-caps labels, ImageSearch photos that miss their subject.

**The Browser-tool leak — fixed (2026-09-28).** Two leaks behind one symptom, a bench that hung after its results:
- *Headless Edge.* The tool launched it lazily and never closed it ("sessions are long-lived anyway"): in the
  product, one Edge per disposed session (every model switch and project close); in the bench, Playwright's pipe
  kept the process alive. Core `Tool` gains an optional `dispose()`, which `session.dispose()` calls for the
  caller-provided `extraTools` only — builtins are shared singletons, and subagents borrow their parent's
  instances. Both Browser tools (server, extension) close their browser there; a launch that completes after
  dispose closes itself.
- *The dev server.* HostSandbox serves on an OS-assigned port, outside the bench's reap range (5173–5200); the
  bench now disposes the sandbox after each run. In the product that server is the preview and stays; the
  project's runtime stops it when the project closes.
- *…and `stopDev()` never worked on Windows with Git for Windows installed* (found by the first batch run, whose
  dev server survived the new dispose): `run()` spawns shell strings through Git Bash, whose path conversion turned
  `taskkill /PID <pid> /T /F` into `taskkill C:/Program Files/Git/PID …`, which taskkill refuses. The kill
  worked when it was written (2026-08-08, when `run()` used cmd) and broke when Git Bash became the host shell
  (2026-08-11, 00:46); the startup sweep landed two hours later and so never worked on such a machine. Since
  then project close, preview restart and the sweep have stopped nothing. The kill is argv form now; a new test
  ends a real process (the old one recorded a dead pid and passed either way), and the fixed `stopDev()` ended a
  real leftover dev server — all six processes of its tree (cmd → npm → cmd → node shim → mise → node).
- *…and after a restart the recorded pid is gone.* Node on Windows kills a process's direct children when it
  exits — the recorded shell — but not npm → vite beneath it: after the first bench arm, five trees ran on with
  dead roots, and a server restart leaves the product's preview the same way, beyond the startup sweep's tree
  kill. When the port is still held after the tree kill, `stopDev()` now ends the port's listener, only if its
  command line names the project's directory; its orphaned parents exit on their own (verified on a real tree,
  then through the fixed code on the arm's three remaining orphans). Two tests: an orphan is reclaimed, a
  stranger holding the port is not touched.

Tests +7 (1,201 green); core, server and extension typecheck clean.

**Acceptance batch (2026-09-28, gpt-6-luna, blank start) — P0 accepted.** Runs `eval/runs/p0-none-luna`,
`p0-none-image` (the stopped 09-27 run's two shop passes kept aside as `p0-none-luna.partial-0927`); rescore in
`eval/design-review/adr086-p0-rescore/`.

| | shop × 3 | landing × 3 | image probe (shop) |
|---|---|---|---|
| builds + scenario check | 3/3 (12.8 · 8.3 · 5.6 min) | 3/3 (7.3 · 7.0 · 7.6 min) | 1/1 (8.0 min) |
| dev contract (`npm run dev -- --host --port <p>` answers) | 3/3 | 3/3 | 1/1 |
| PLAN.md written by the plan stage, before code | 3/3 | 3/3 | 1/1 |
| HARD-failing views (light 1440 · dark 1440 · light 390) | 0 of 12 | 0 of 3 | 0 of 4 |
| raw colors / app outside the theme file | 2.3 | 0.3 | 35 |
| contrast fails / view (light 1440) | 0.1 | 7.7 | 4.8 |
| dark pass went dark · overflow @390 | 12/12 · 1/12 | 3/3 · 0/3 | 4/4 · 0/4 |

The probe's plan took its direction from the image: the palette matched all four reference colors (mint
`#ecfbf5`/`#ecfdf5` ΔE 0.5, deep green `#064e3b` exact, emerald `#00b884`/`#10b981` 0.6, orange CTA
`#f4510b`/`#ea580c` 2.0), and its type (Manrope / Inter), layout (shipping strip, dark-green split hero,
benefits row, category pills, grid) and logo came from it too. Every plan named a real logo form and a type
pairing; 6 of 7 builds checked their app in the Browser.

**Findings, and what changed (unmeasured until the next batch):**
1. *The plan rule flagged its own ban.* "never emoji" drew a revise round in 3 of 7 runs (the None planner's
   rule, echoed) → the rule now counts only emoji that are planned, not banned (tests).
2. *A reference image's dark band had no token.* The probe's build hard-coded 35 colors — the image's deep green
   as a strip, a hero panel, buttons — because the token set had no role for a band in the opposite value →
   `inverse` / `inverse-foreground` in the None skill's token template, and in the planner's extraction list.
3. *Contrast.* Landings: about two thirds of the failures are the customer-logo strip's grey wordmarks
   (logotypes, which WCAG exempts; the instrument cannot tell), the rest secondary text at ~70% opacity on the
   primary band (3.8–4.2:1) and a saturated accent as text in dark mode (3.4:1). The probe: the accent as text
   on light surfaces (2.8–3.0:1) → two §8 rules (every role used as text reaches 4.5:1 in both modes; text on a
   colored band uses its `-foreground` at full strength).
4. *Anchoring.* All three shops and the probe planned a rounded-square monogram — the planner example's logo
   → the example is marked format-only, its logo drawn from its subject. Type: 6 of 6 image-less plans chose
   Space Grotesk (Luna's own default, not our text); 1 of 7 fell back to "system sans" — watched, not ruled.
5. *Verification is optional.* landing-a1 never opened the Browser and passed anyway — the post-turn check
   (ADR-085 P2) is the structural answer, not another rule.
6. *Instrument fixes.* The rescore dropped single-attempt runs (now filtered by scenario); the capture read a
   40 px strip as the page background, so the probe's dark pass — dark in its screenshot — scored as light (a
   page layer is now wide and tall); the contrast sweep skipped an element's own background color under its
   gradient, scoring light text on a dark panel 1:1 against the page (fixed, with a test). Contrast and "dark
   went dark" numbers from before 2026-09-28 are not comparable: rescore a baseline before comparing.
7. *Deferred:* the Browser tool restarts a slow-but-alive dev server after a 3 s HTTP probe (shop-a2 started
   two) — harmless now that a restart stops the old one; a TCP liveness check would avoid it.

Suite after the findings' fixes: 1,203 green (+2: the emoji rule, the gradient compositing); core, server and
extension typecheck clean.

**Next:** P1, proposed for approval with the concrete file list; its Luna batch adds a None arm to measure
findings 1–4.

## P1 progress (2026-09-28)

**Decisions (user-approved):** (1) Restyle swaps only the blocks a project has not edited, and names the ones it
leaves; (2) the spacing tokens keep their names (`--section-y`, `--section-y-lg`, `--hero-y` — the theme contract,
the seeds and Restyle depend on them; the Architecture's `--section-gap`/`--hero-pad` were placeholders): the fix
is ownership, not naming; (3) a kit or block file that differs from every shipped version is checked like the
app's own code — only what the edit ADDED counts.

**Built (uncommitted), 1,216 tests green after round 2's fixes:**
- *Unfrozen.* `frozenPaths: []` for both starts; BUILDER_BEHAVIOR's design line says the blocks are patterns (hash
  pin moved on purpose); TemplateAudit's frozen-layer HARD check and its "no block imports" finding retired (an
  edited kit file's raw colors are still read); `designChecks` takes a `shipped` lookup (base + skin versions)
  and counts an edit's additions; `applySkin` never overwrites an edited block. Model-facing text — the design,
  architecture, landing and browser skills, the React planner, the smoketester, AI_RULES, the scaffold — says
  "patterns: use, edit or adapt (keep the data-block stamp and the tokens)".
- *One rhythm.* Every band root carries `data-band` (Section by tone, Hero, CTASection); one unlayered rule in
  `index.css` drops the bottom padding of a band followed by one of its kind, so two paddings never stack; the
  band that follows decides the gap. `<Section compact>` (60% of the step, stamped `data-compact`) for a thin band
  that sits under the band it supports. PageHeader is a title row inside the view's first Section; the bleed
  hero, the CTA and the skins use the tokens; the full CTA's text is primary-foreground at full strength.
- *A brand, not a stock icon.* NEW `Logo` block — first built with symbol / monogram / wordmark forms, then
  reduced by the user's decision to the wordmark alone (see "The brand" below). The scaffold, every demo page,
  the category skills and the generated references use it, and the commerce example no longer carries the
  bench's own brand name ("Cascade Shop" → "Harbor & Pine": an example that shares the scenario's name is an
  answer key).
- *Design skill v3:* patterns, rhythm (one owner per band), density (an anchor in every band, vary the
  layouts), the brand, P0's contrast lessons. The React planner's Design line gains `logo:`.
- *Instrument:* `rhythm` (content-to-content gaps between bands; a band with a surface of its own counts from its
  edge; under 24 px is stacking, not spacing; gaps beside a band DECLARED thin are reported apart as an intended
  second step — undeclared apps have every gap counted) and `logo` (kind and mark height); two rescore columns.
- *Bench:* `--free-brief` retired into `--template none`.

**Measured so far:** today's template on Luna (`p1-base-react`, 6/6 builds, rescored): logo = a bare stock icon in
5 of 6 apps (16 px in every shop); landing gap max/min 2.6 — stacked paddings (≈120 px) against single ones
(≈48–56). The template's own reference pages after P1, same instrument: gap ratio 1.0 (portfolio) and 1.27
(SaaS, launch, waitlist).

**Round 1 (`p1-react`, 6/6 built, 0 HARD):** no bare icon left (6 distinct marks, all 36 px: monogram ×2, symbol
×4); landing gap max/min 1.7 · worst 2.4 — the worst from anchor wrappers (`<div id="faq"><Section/></div>`, for
nav links) that hid adjacent bands from the rule; one hero overflowed 390 px by 61 (a live product panel in a
grid with no mobile column). → Section/CTASection take `id`; the rule sees through one wrapper; the hero grid
starts from `grid-cols-1` (on the built CSS, wrapped bands now measure 80/80/80 like siblings).

**Round 2 (`p1-react-2`, 6/6 built):** landing gap 1.3 · worst 1.4, 0/3 overflowing — and 3 HARD: every landing
paired a full CTA with an outline action, which painted the page background under primary-foreground text
(1.01:1; a latent block bug the baseline never hit, because it used the panel CTA); two carts overflowed 390 px
(CartRow's ~348 px of fixed parts in a padded two-column layout copied from CheckoutPanel's grid). → the full
CTA restyles its outline and link actions; CartRow stacks its controls on a phone; CheckoutPanel and every
reference grid start from `grid-cols-1`, and the design skill says why (on real pages: the reference launch page
with a full CTA + outline action has 0 invisible actions in light and dark; the reference cart at 390 px, 0 px
of overflow).

**P0's findings, measured (`p1-none` 6/6, `p1-none-image` 1/1 built, 0 HARD):** emoji revise rounds 0 of 13 plans
(was 3 of 7); None landing contrast fails / view 7.7 → 4.7; logos varied — wordmarks and subject symbols, no
copied container; the probe's raw colors 35 → 6, with `inverse` in its plan (taken from the image) and theme.
Watch: None landing raw colors 0.3 → 3.3 per app (palette utilities).

**Round 3 (`p1-react-3`, every fix above) against today's template (`p1-base-react`)** — rescore
`eval/design-review/adr086-p1-r3/`:

| | today's template | P1, round 3 |
|---|---|---|
| builds · HARD · raw colors · theme contract | 6/6 · 0 · 0 · 6/6 | 6/6 · 0 · 0 · 6/6 |
| invisible CTA · overflow @390 | 0 · 0 | 0 · 0 |
| landing gap max/min (avg · worst) | 2.6 · 2.6 | 1.3 · 1.4 |
| logos | bare stock icon ×5, symbol ×1 (16–23 px) | symbol ×6 (36 px) |
| landing contrast fails / view | 1.3 | 1.3 |
| landing never-list | dot-meta 1 | dot-meta 2, brand-wall 1 |
| shop width jump between views | 82 px | 37 px |

**Acceptance:** content-gap ≤ 2× — met (worst 1.4 on the landings, where bands stack; a shop view has one to three
bands and its ratio is title-to-content, reported, not judged); no objective regression — met (0 HARD, 0 raw
colors, contrast unchanged, 0 overflow); ≥ 3 distinct logo forms — NOT met: every round-3 mark is a symbol
(round 1 had monogram ×2 + symbol ×4), and two landings took `Activity`, the icon the SaaS reference page gives
its "Cadence" — the references anchor again, as in P0's finding 4; pairs ≥ 5/6 — met, 5 of 6, judged by Claude at
the user's request (the blind page was unusable: clicking a screenshot opened it, the pick buttons did not work,
and one side per pair was hidden — the user asked for a direct, labeled comparison and a judgment instead):
- shops 1–3: new. Today's shows a 16 px icon, a doubled heading over an empty band, and photos that miss their
  products (a tiger for an enamel mug, machinery for a wool throw); the new ones have a real mark, one heading,
  matching photos. (Shop 2 is closer — both matched their photos; the new one's "Add to cart ↗" reads as a link.)
- landing 1: new — the hero shows the product (a live incident panel) instead of a laptop stock photo, even rhythm,
  a legible full-color close. Landing 2: new by a little — same stock photos in both; the logo, headline and
  close are better. Landing 3: today's — the new page's bento media blew a timeline's icons up to 200 px circles
  (a 1,500 px band): the block's `[&_svg]:size-full` sized every icon inside custom media, not just the art.
  → Every media slot (BentoGrid, MediaCard, Hero, ProfileHeader, CartRow; base and skins) now sizes only its
  direct child (on the built CSS: a nested icon stays 16 × 16, art and photo still fill the slot).
- Seen in both, not fixed here: a mostly empty stat tile in every bento; real companies in some logo strips.

**Round 4 (`p1-react-4`, user-approved):** the media-slot fix above, plus — the bento's stat tile is composed (its
label on top, the number at the bottom over an optional `trend` drawn as min–max-scaled bars, on a tinted ground)
and its last tile widens to fill its row (six tiles had left the accent alone); logos are decided from the NAME
(a rule in the design skill: an image name → a symbol of that image, an invented name → a wordmark, initials →
a monogram; never a generic category icon), and the references' "Cadence" became a wordmark, so `Activity` is no
longer offered in four places. The brand wall (real companies as customers) stays open.

**Round 4 result (`p1-react-4`, 6/6 built; rescore `eval/design-review/adr086-p1-r4/`):** landing gap max/min
1.4, shops 1.5; 0 raw colors; 0 overflow at 390 px; landing contrast fails / view 1.7 (today's 1.3). The losing
round-3 page is fixed on a model-built page: its bento shows the product inbox at the right scale, the stat tile
carries its trend bars, the last row fills. One HARD: shop-a1's checkout crashed (`confirmed is not defined`) — the
model's Browser check found a checkout bug at turn 56, it edited the fix at turns 57–59, and the bench's 60-turn
cap ended the run before it rebuilt (today's-template shops also average the cap: 61 turns). The product has no
such cap; the bench's shop check, though, ran `vite build` without `tsc`, so it scored the red build as a pass.
→ Closed (user-approved): ten design-scenario checks now run the product's own `npm run build` through one
helper (`eval/builder/_lib/productBuild.mjs`; graduate and fullstack keep their offline builds) — on the real
workdirs, the crashed shop now fails with `TS2552: Cannot find name 'confirmed'` and a sound one still passes.
Solved rates from before 2026-09-28 were scored without the typecheck.

**The brand, decided by the user (2026-09-28): the app's name as a wordmark — no logo mark.** A logo is personal;
the owner brings their own, and a well-set name is the brand until then. `Logo` is now just that: the name (or its
short form) in the bold display face with one detail in the primary color (the last word of a two-word name, or
a dot) — no symbol, monogram, shape or icon props, and no logo library. The planners no longer plan a logo; every
reference, skill, the scaffold and the None start's design skill use `<Logo name="…" />` (verified on the
reference shop's navbar and the SaaS footer). The criterion "≥ 3 distinct logo forms" is dropped — it could not be
met by consistent design anyway (two products, three runs each) — and the logo check is now: the brand is a styled
name, never a stock icon beside plain text. Round 4 ran before this change (its logos followed the name rule).

## P2 progress (2026-09-28/29)

**Attempt 1 (`p2-qwen-react.stopped-0929`, user-approved; stopped after one run).** Setup: qwen36-agentic
at its own tune (temperature 0.6, presence 0.5), both starts, shop + landing × 3, up to 2 follow-up rounds, 60 min
a run; the checks run `npm run build` (typecheck + bundle). The first shop failed on the machine, not the design:
at turn 14 its own `npm run build` hit `spawn EPERM` inside the Windows write-fence, and it spent the rest of that
round and both follow-ups (60 + 60 + 28 turns) "repairing" the toolchain — deleting its `node_modules` link,
writing its own tsc runner — until the 60-minute cap. The fence blocks every piped spawn (esbuild, npm scripts),
and it has done so in every fenced bench run that built since 2026-09-27 (87 of 87; ADR-083 → this ADR, Luna and
Qwen alike): no model could run `vite build` in its own shell, and the follow-up text asked for exactly that. The rounds P2 measures
would have measured the fence, so the batch was stopped four minutes into run 2 (no leaked processes; Qwen
unloaded). → **ADR-087** (proposed): the fence's `workspace-write` at low integrity — a prototype passes
`npm run build` and `npm install` inside the fence while writes outside stay denied. P2 re-runs after it.

**Attempt 2 (`p2-qwen-react.stopped-disk-0929`, 2026-09-29, on the accepted ADR-087 fence) — stopped by the
machine, one minute in; nothing scored.** Loading Qwen (24 GB at the oracle's 131k context, ~43 % on the CPU)
needs ~20 GB of memory commit; with the owner's usual apps open the machine had ~12 GB free (≈ 50 of 62 GB
committed), so Windows grew the page file 33 → 53 GB until C: reached 0 bytes and new processes could not
start ("the paging file is too small"). The batch's new disk guard (stop below 2 GB free) caught it; the bench
was killed in-process and Qwen unloaded (C: back to 21.8 GB free, commit 12.6 GB free). P2 needs ~15–20 GB more
headroom before it can run — the owner's call (close apps for the run, or give the page file room off C:).

**Attempt 3 — the result (`p2-iq4-react`, `p2-iq4-none`, 2026-10-04; rescore `eval/design-review/adr086-p2/`).**
Model: the owner's downloaded Unsloth quant `hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS` (owner's call:
`qwen36-agentic` had been deleted to free disk and is not rebuilt). It ships no sampling defaults, so: temperature
0.6, top_p 0.95, top_k 20 (Qwen's thinking-mode values), presence 0.5 (the baseline's), 131k context (the
baseline's). ~47 tok/s, 70 % on the GPU, ~3× the old model. On the ADR-087 fence; 168 min for 12 runs.
**Caveat:** the baseline (the oracle's A arm) is a different model on the broken fence; its 6 kept apps re-run under
today's checks (typecheck + bundle) are unchanged at 5/6.

| | A: old template, qwen36-agentic | P2 React (open) | P2 None |
|---|---|---|---|
| solved (bench check) | 5/6 | **6/6** | **6/6** |
| first try / follow-up rounds | – | 6/6 · 0 | 4/6 · 2 |
| minutes / run | 10–23 | 8–15 | 8.5–23.5 |
| the model's own `npm run build` green | 0 of 30 (all `spawn EPERM`) | 11 of 14 | 19 of 20 |
| HARD-failing views | 0 | **0** | **5 in 3 apps** |
| landing gap max/min | 2.8 | **1.3** | 2.0 |
| overflow at 390 px (shop views) | 1/12 | 0/10 | 0/9 |
| contrast fails / view (landing) | 1.5 | 1.7 | 13.0 |
| brand | stock icon, 16 px | wordmark | wordmark (one icon) |

- **React start: acceptance met.** No HARD regression (0 vs 0), a better solved rate, even rhythm, wordmark brands,
  no overflow; every run solved first try. Seen, not HARD: photos that miss their product (a beach for a wallet, a
  street for a sweater — the library pick), the brand wall (real companies in 2 of 3 landings), one icon-only cart
  button the capture could not find by name.
- **None start: acceptance NOT met on HARD** — every finding verified on its screenshot and source: shop-a1 shows 4
  of 6 product photos broken (no photo library here, so the model invented Unsplash ids) and a blank page on every
  product click (its hand-written `useView` stores JSON in `location.hash`, which the browser percent-encodes, so
  `JSON.parse` fails on the way back — the React start's tested `useHistoryView` cannot do this); shop-a3's cart badge
  is grey on blue (1.07:1); landing-a3's "Read the docs" sits dark on dark (1:1) in its closing band — the bug class
  P1 fixed in `CTASection`. The best page of the batch is a None landing (landing-a3: a live dashboard hero, dense
  sections), but free themes also carry raw hex (21 per landing) and many low-contrast lines.
- **Rounds:** React needed none. Both None follow-ups came from the check, not the app — the model set the brand as
  the short form ("Cascade.", the owner's brand rule) and the shop check wants the literal "Cascade Shop" in the
  bundle. → bench fix: accept the wordmark's short form.
- **Why the None defects shipped:** the bench check reads the bundle, so nothing told the model about a broken image,
  a blank view or an invisible label. That is ADR-085's planned P2 (eyes: run the design instrument after the turn
  and send HARD findings back as a follow-up) and P3 (photos for both starts) — the next work, now for the None start
  first.
- Bench, seen once: a `vite preview` the model started with `nohup` (absent on Windows) outlived the run and hung
  the arm's teardown; the driver's 60 s guard reaped it.

## References

ADR-085 (instrument, oracle, P0 progress), ADR-083 (the six-arm experiment, the free-design arm), ADR-057,
ADR-066 (packs), ADR-081 (runtime). Evidence: `eval/design-review/oracle-rescore/`, `oracle-pairs/`,
`adr085-p0-rescore/` (gitignored).
