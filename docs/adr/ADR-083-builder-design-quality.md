# ADR-083 — Builder design quality: taste in the library, direction in the plan, checks over prose

Extends **ADR-057** (design system v2) and **ADR-054** (builder design system); touches **ADR-056** (plan
stage), **ADR-060** (Browser) and **ADR-071** (ImageSearch). Status: **proposed 2026-09-27; its Decision
and Phases were superseded the same day by ADR-085**, after the six-arm experiment recorded below. The
Context, research and principles here remain the record of *why*; implement ADR-085's phases, not these.

## Context

**The review (user, 2026-09-27).** Generated apps are correct but read flat and generic. Product cards look
good; the hero, the band right after it, and the footer do not; e-commerce pages have no sense of layout.
The ask: teach the builder real UI/UX design — spacing, typography, composition — in a form a weak local
model (Qwen-class 27B, including Unsloth quants) can actually apply.

### What the evidence says (measured on this branch)

**1. The latest real build fails for specific, fixable reasons** (Harborline Coffee,
`packages/server/cascade-projects/wsl-verify-run3-d477b337`, built and screenshotted 2026-09-16):

| What the user sees | Cause |
|---|---|
| Hero art is abstract polka dots on a coffee shop | The model asked for a photo (`<Photo web="coffee beans">`); the keyword host answered 401 and `<Photo>` fell back to `ArtImage`. (154d3f3 has since added a picsum fallback — a real photo, but a random one.) The product cards used `ImageSearch` URLs and look good. |
| A violet coffee roaster | PLAN.md's Design line is a block list: `preset: premium; catalog: NavBar+Hero+Section+MediaCard grid+Footer`. Presets are chosen from the user's adjectives; with none, `premium` (violet) stays. Nothing reads the subject. |
| Band 2 looks empty | No block fits "three values", so the model hand-rolled one with `✦` and `◌` glyphs as icons. |
| AI-looking details | An accent-colored phrase in the h1, `→` in the CTA, a `·`-joined badge, duplicate fixed floating controls. |

**2. The library has a median-template ceiling.** The demo gallery (written by a strong model with the same
blocks) looks decent, so the blocks are not broken — they are generic:
- `Section` has one header shape on every band: an uppercase tracked eyebrow, a `text-3xl` heading, a muted line.
- `Footer` is small and muted, and plain-string links render as `<span>` (not links).
- `LogoStrip` is bordered cells of same-face text; `FeatureGrid` is the identical-card kit.
- `Hero layout="centered"` never renders `media`, although the landing skill recommends it.
- 4 of 6 presets use Geist for display AND body, and only 3 font files ship. The design skill still says
  "the serif is the personality"; `premium.css` and ADR-057 still claim Fraunces/Inter.
- The `sharp`/`soft` skins differ by radius and rule weight only (the skin gallery shows near-identical heroes).

**3. Our own skills mandate generic defaults.** landing/SKILL.md's acceptance checklist *requires* a
two-tone headline; one band spine (`Hero→LogoStrip→Bento→Pricing→Testimonial→FAQ→CTA→Footer`) serves every
landing; eyebrows are on by default.

**4. Nothing looks at the page.** TemplateAudit — the only gate enforced before "done" — is structural.
`eval/runs/matrix-9b-n3` builder-landing trial 3 is `solved: true` and its screenshot is blank. Bench
screenshots are 1440×900 above the fold, taken after the verdict, and the bench omits AI_RULES.md, Browser
and ImageSearch (`scripts/eval/builder.mts`), so it does not measure the product as shipped.

**5. Prose rules are skipped; enforced ones hold.** Mandated skills load reliably (EVAL-BASELINE rung 9), but
in passing runs the self-attested rules were skipped: BentoGrid over FeatureGrid, the collage hero, one
primary CTA, the dark-mode check, "count the photos", reading `pages.md`. TemplateAudit, the one enforced
check, held. ADR-057's earned lesson applies again: a design system for weak models is only as strong as its
most concrete example — and as its checks.

**6. Budget.** Design context is ≈6k tokens mandatory and ≈17k if every pointer is followed; skill results
have no compaction shield; below a 24k window the skills index lists names only.

**7. Imagery guidance contradicts itself** across ~6 files. The design skill says keywords are "decorative
only" and ImageSearch is the way to match a label; planner.md, planStage.ts, the commerce and browser skills,
the smoketester and imageSearchTool.ts still present keywords as the catalog answer.

### Research: six external skill sources (cloned into `_temp/design-skills/`, gitignored, kept)

| Source (commit) | What it really is | License | Verdict |
|---|---|---|---|
| A vendor skills repo's `frontend-design` (3337550) | The only source about *taste*: ground the design in the subject; open the hero with the most characteristic thing of that world; typography carries personality; a calibration list of AI-default looks; spend boldness in one place; plan → review against the defaults → build → screenshot critique; copy rules | Apache-2.0 | **Distill** into the planner, the blocks and checks |
| `web-design-guidelines` (063bee9) + `web-interface-guidelines` (e3d624b) | An audit command that fetches ~100 rules at runtime and reports `file:line`. Accessibility and polish: focus-visible, links are links, `…`, tabular-nums, text-balance, image dimensions, reduced motion, layered shadows, nested radii, hue-tinted borders. Nothing on composition | MIT | **Bake into blocks; ~15 rules into TemplateAudit**; no runtime fetch |
| The `building-components` spec (ba72745) | A spec for authoring component *libraries*: artifact taxonomy, compound components, asChild, `data-slot`/`data-state`, cva variants, registry/npm publishing | Apache-2.0 | **Our authoring standard for new blocks**; never shown to the builder |
| The `ui-ux-pro-max` skill (823b0a1) | A Python BM25 search over CSVs: 192 product types → style, palette, landing pattern, font mood, anti-patterns | MIT | **Port the idea, not the skill.** Needs Python (absent in node:20-alpine); misroutes common prompts ("SaaS landing page" → Link-in-Bio builder, "online store" → Pharmacy); 150/192 palettes are Tailwind defaults; ≈4–13k tokens |
| A mobile-design `agent-skills` pack (aa88b4d) | A client for a paid mobile-design SaaS | MIT | **Two rules only:** write a style direction, and express personality through colour, type and imagery rather than unusual layout; review with full-height screenshots |
| canvas-design, theme-factory, brand-guidelines, web-artifacts-builder, composition-patterns, writing-guidelines | Poster art · 10 basic palettes · a vendor's own brand · our own stack · React architecture · a second runtime-fetched audit | — | **Skip** (canvas-design's OFL fonts are useful raw material) |

**Why none is copied in verbatim.** (1) They assume a model that writes free-form CSS; our builder composes
frozen blocks, and "choose your typefaces deliberately" beside "never improvise styling" makes a weak model
oscillate (the design-v3 conflict in ADR-057). (2) Loading is not the bottleneck — applying is (Context 5);
more prose means more skipped rules. (3) The budget (Context 6). (4) Runtime needs we cannot meet: a
per-run network fetch, Python, a paid key.

### Experiment (2026-09-27): why the plan below was replaced

A six-arm A/B (artifacts in `eval/design-review/adr083-ab/`, gitignored) tested the plan's assumptions on
`builder-shop` and `builder-landing`: gpt-6-luna in the template with and without ui-ux-pro-max (N=3 each),
Claude Opus and gpt-6-luna designing freely with the skill, Claude inside the template, and the local
qwen36-agentic 35B-A3B designing freely. Findings: the template caps every model inside it (Claude ≈ Luna
there); freedom + eyes + real photos lift a model that authors, but free output breaks the token system
(325–463 raw colors, ~296 px width drift); the local model does not author a design when free; the skill
changes nothing inside the template (loaded 6/6, applied 0/6); size is the wrong switch. A four-strategy
design panel, judged on three lenses and checked against the code by two critics, turned this into
**ADR-085**: one rebuilt template for every model, server-resolved direction and photos, a server-run
design check for everyone, and freedom earned by the project, never by model id. The full per-arm table
is in ADR-085's Context.

## Decision (superseded by ADR-085 — kept for the record)

### Principles

1. **Taste lives in code we author** — blocks, presets, fonts — reviewed by eye at the gallery gate. The
   model inherits taste; it is never asked to invent it.
2. **Direction is a closed-choice brief** the planner writes before any code, grounded in the SUBJECT: the
   coffee world supplies the palette, type and hero image — not the user's adjectives alone.
3. **Personality through color, type and imagery, not layout.** Layout stays inside certified blocks.
4. **Every rule that matters has a deterministic check that names the fix.** A prose-only rule is optional by
   construction; we write it expecting it to be skipped.
5. **One source of truth per rule.** Skills, planner, prompts, examples and checks agree (ADR-057).
6. **Refuse the default looks on purpose**, including the ones we ship today: the identical-card kit, an
   ALL-CAPS eyebrow over every heading, one accented phrase in the headline, `→` on buttons, `A · B · C`
   meta strings, cream + serif + terracotta, near-black + one acid accent.
7. **Adapt, never vendor.** No runtime-fetched rules, no Python, no paid APIs; ported data keeps its notice.

### The four layers

| Layer | Owner | Today | Target |
|---|---|---|---|
| Library | us | median-template blocks; 4/6 presets share a face; micro-skins | varied, better blocks; a distinct display face per preset; subject-grounded presets |
| Direction | planner | a block list + the default preset | a short brief chosen from menus; the hero photo resolved before the build |
| Composition | builder skill | one landing spine; the two-tone mandate | band recipes per category; a never-list; copy rules; ≤3k tokens, pinned |
| Verification | checks + eval | a structural audit; a blank page passes | design checks that name fixes; full-page review; a measurable score |

### Phases

Each phase is one batch → one eval against the Phase-0 baseline, N=3 per scenario (ADR-057's ladder
method). The user approves a phase before its code is written; later phases may be re-planned from what
earlier ones measure.

**Phase 0 — Make design measurable (prerequisite).**
- Bench parity: bench sessions get AI_RULES.md, Browser and ImageSearch, as the product does
  (`scripts/eval/builder.mts`).
- Screenshots *before* the verdict, full-page, at 390 and 1440 px, light and dark.
- **A blank page is a correctness FAIL** (objective: no visible text or media once the page has loaded).
- Composition metrics, reported and not gating: the h1-to-section-heading size ratio; bands with no visual
  anchor; whether the hero has a real photo (not `ArtImage`); consecutive identical section headers; footer
  link and column counts; glyph/emoji icons; filled primary buttons per viewport; horizontal overflow at 390 px.
- A design score: an offline vision judge with a fixed six-criterion rubric (subject fit, hierarchy, imagery,
  rhythm and variety, polish, default-look tells), stored per run and **never a gate**, calibrated by a human
  pairwise review of a sample.
- Two new probe scenarios with no style adjectives and distinct subjects (e.g. a coffee roastery, a dental
  clinic) to test subject grounding.
- The baseline is recorded in EVAL-BASELINE.md on the target model (27B-class); the 9B runs only as the
  integrity floor.

**Phase 1 — Correctness and self-inflicted defaults (small, mostly text).**
- Imagery: the hero's media is an ImageSearch URL or a bundled photo, never `<Photo web="keywords">`; the
  ~6 contradicting sources are reconciled to one rule.
- Drop the two-tone-headline requirement and eyebrows-by-default from the skills and their examples.
- TemplateAudit (SOFT): glyph/emoji icons, `→`-suffixed CTA text, `·`-joined badges, a keyword `<Photo>` in
  a Hero, duplicate fixed controls.
- The server applies PLAN.md's `preset:` deterministically after the plan stage; today it relies on the
  model calling Restyle.
- Fix `Hero layout="centered"` dropping `media`; correct the stale font claims (premium.css, the design
  skill, ADR-057) and luxe-dark's "dark is the intended default"; retire the architecture skill's "delete
  demo/" instruction.

**Phase 2 — Raise the library ceiling (the biggest visible lift; model-independent).**
- Typography: a distinct display face per preset from OFL families (e.g. Instrument Serif, Bricolage
  Grotesque, Young Serif, Outfit, Big Shoulders) as latin-subset variable woff2, within a per-preset byte budget.
- Presets: grow toward ADR-057's registered menu (10–12), grounded in subjects (warm-organic, clinical,
  fintech-trust, luxury, outdoor-rugged, kids, dev-tool…), hand-tuned in oklch, avoiding the default looks.
  ui-ux-pro-max's product→mood/anti-pattern table is research input; its hex palettes are not imported.
- Blocks, authored to the components.build standard (cva variants, `data-slot` parts, accessibility):
  - `Section` header variants (centered, split, none) with the eyebrow opt-in and a larger landing h2;
  - `FeatureRows` (image-led alternating rows — the band-2 fix), a full-bleed `ImageBand`, an inverted band;
  - commerce `ProductHero` and `CategoryTiles`; a real logo cloud;
  - `Footer variant="rich"` (a large wordmark, newsletter, real `<a>` columns, socials, a legal bar);
  - Hero layouts: type-led editorial, product, stacked.
- The WIG polish baked into every block: `text-balance` headings, `tabular-nums` prices and stats, visible
  `focus-visible`, links as `<a>`, layered shadows, semi-transparent borders, nested radii, image dimensions.
- Skins: rebuilt as real structural alternatives or retired, decided at this phase's gallery gate.
- Gate: every new block and preset is approved by eye in the demo gallery; `genKitReference` is regenerated.

**Phase 3 — Direction in the planner.**
- The Design section becomes a brief of closed choices: `category`, `productType` (an enum of ≈40 web-app
  types), `mood` (three adjectives), `preset`, `hero` (a layout plus a 2–3-noun image subject), `signature`
  (the ONE bold moment), `bands` (a recipe from the category menu), `avoid` (two default looks).
- A small data table maps `productType` → default preset, hero layout, band recipe and avoid-list, so the
  planner classifies instead of inventing (a weak model sorts into ≤40 buckets reliably; the BM25 routing was
  the weakest step in ui-ux-pro-max). `other` falls back to a neutral preset; the user's own words win.
- The server resolves the hero image from the brief through the ImageSearch backend and writes the URL into
  PLAN.md, so no tool call is required of the model.
- `planQualityIssues` validates the brief: known enum values, required fields present, a preset consistent
  with the product type unless the user asked otherwise.

**Phase 4 — Builder design skill v3.**
- Rewritten as a menu: apply the brief → pick the band recipe → the never-list (each item backed by a
  Phase-1 or Phase-5 check) → copy rules (active voice, specific CTA labels, sentence case, numerals, no `→`).
- ≤3k tokens, delivered on the pinned system-prompt path (like PLAN.md) so compaction cannot drop it;
  references stay on demand.
- A consistency test fails when any skill, planner text or example contradicts a design rule.

**Phase 5 — Visual review loop.**
- `Browser {op: "design"}`: the Phase-0 metrics computed live and returned as named fixes ("band 2 has no
  visual anchor → FeatureRows with photos"; "the footer has 2 links → Footer variant=rich").
- A vision critique of a full-page screenshot, only when the model has vision (`modelCaps`), capped per session.
- A read-only `design-reviewer` subagent (like the smoketester), inert by default and enabled by evidence.

### Where each source lands

| Source | Lands in | Form |
|---|---|---|
| frontend-design | the planner brief, the block redesign, the never-list, copy rules | distilled rules + checks |
| web-interface-guidelines | block internals, TemplateAudit, the reviewer checklist | a pinned subset; no runtime fetch |
| building-components | how we author blocks | a contributor standard; not shipped |
| ui-ux-pro-max | the productType table, band recipes, font research | a small data file; no Python, no BM25 |
| sleek | the brief's mood field; full-height review | two rules |

### Non-goals

- Unfreezing blocks for the model: taste stays in code we author (Principle 1).
- Copying any third-party skill into `packages/server/skills/`, or fetching rules at runtime.
- Tuning for models below the 9B floor.

## Consequences

- **Better:** design quality rises for every model at once, because the library does the work; the plan
  carries a subject-grounded direction; failures become visible and measurable instead of passing blank.
- **Costs:** more blocks, presets and fonts to maintain (the skin parity check and the gallery gate grow with
  them); font bytes per app; longer bench runs (full-page shots, metrics, the judge).
- **Risks and mitigations:**
  - the model still hand-rolls where no block fits → Phase-5 metrics name the gap, and gaps become new blocks;
  - the judge turns into a hidden taste gate → it only reports, never gates;
  - a new check fires on correct code (ADR-057 dropped its one-CTA check for this) → every check starts SOFT
    and is promoted only after zero false positives on the gallery and on real traces;
  - subject routing makes apps of one type look alike → the brief's mood and signature fields vary them, and
    the user's own words always win.

## Anti-overfit guarantees (amending ADR-057's)

- Pass/fail stays objective: deterministic checks only. The design score is a reported metric for A/B.
- Activation is data: the productType table and the preset menu are files; no model-specific branches.
- Every new rung is inert by default and activated on evidence (the reviewer subagent, the vision critique).
- The target is the 27B class. The 9B floor is an integrity check (no crashes, no regressions), never a
  convergence target.

## Validation plan

- Scenarios: the existing builder set plus the two Phase-0 probes, N=3 per cell.
- Per phase: objective checks must not regress; composition metrics and the design score must improve over
  the baseline; a human pairwise review of a sample confirms the direction.
- Each phase's numbers are recorded in EVAL-BASELINE.md.

## Open questions

1. The judge model for the offline design score: a hosted vision model or a local one.
2. Whether the target builder model reports vision (`modelCaps.hasVision`); it decides Phase 5's shape.
3. Skins: rebuild or retire (Phase 2).
4. The preset count and the per-app font byte budget.
5. The productType taxonomy: ≈40 types, and who curates the table.

## Files (by phase, when approved)

- **0:** `scripts/eval/builder.mts`, `eval/builder/_lib/designLint.mjs` plus a composition-metrics module,
  `eval/design-review/` (rubric + judge script), two new `eval/builder/` probe scenarios.
- **1:** `packages/server/skills/builder/{design,landing,commerce,browser,architecture}/`,
  `packages/server/agents/builder/{planner,smoketester}.md`,
  `packages/server/src/{planStage,auditTool,projectManager,imageSearchTool}.ts`,
  `packages/server/templates/react/src/components/blocks/Hero.tsx`, the theme file headers.
- **2:** `packages/server/templates/react/{src/themes,src/fonts.css,src/assets/fonts,src/components/blocks,
  skins,demo}/`, `scripts/gen/genKitReference.mts`, the design-system tests.
- **3:** `packages/server/agents/builder/planner.md`, `packages/server/src/planStage.ts`, a new productType
  data file under `packages/server/`.
- **4:** `packages/server/skills/builder/design/` (plus landing and commerce), `BUILDER_BEHAVIOR` in
  `packages/server/src/projectManager.ts`, a skills consistency test.
- **5:** `packages/server/src/browserTool.ts`, `packages/server/agents/builder/design-reviewer.md`.

## References

ADR-054, ADR-055, ADR-056, ADR-057, ADR-060, ADR-071, ADR-072; EVAL-BASELINE rungs 9 and 11. The external
sources are cloned in `_temp/design-skills/` at the commits in the research table.
