# ADR-057 — Design system v2: presets, blocks, imagery, design-lint

> **Status:** accepted 2026-07-19 (user: "the quality of software it produces was not as good as frontier
> models… it could be better by skills/templates/prompt etc — but I also don't want it to overfit").
> Premium preset shipped + user-approved at a visual gate; measurement loop live.

## Context

iterate-7 proved the agentic machinery (5/6 rounds verified, 69 compactions, zero errors) but the
produced app was visually bare next to hosted-builder output. Research into how hosted builders get
consistent quality found the edge is INJECTED DESIGN KNOWLEDGE, not model IQ:

- the design system comes first: no one-off custom styles, every colour through semantic tokens;
  ambitious styles/variants defined ONCE, up front; an explicit "wow them" quality bar.
- Pages are built from a BLOCK/section vocabulary (never whole-page freestyling).
- Style keywords (premium/minimal/playful…) act as parameters; images are never placeholder-looking.
- Our own fixture mandated "an emoji as its image" — part of the gap was self-inflicted.

## Decision

Everything lands in DATA (template, skills, planner contract, eval fixtures); core untouched; the VS
Code extension verified isolated (zero references to server design assets).

1. **Theme presets** (`templates/react/src/themes/<name>.css`, tweakcn anatomy): complete token set per
   preset — all shadcn color roles (light+dark, oklch), font trio, radius, tinted shadow system. The
   ACTIVE preset is one `@import` line in `src/index.css` — a one-line Edit is the entire "apply a
   theme" operation (weak-model-sized). `premium` ships first (warm neutrals, deep-violet accent,
   Fraunces/Inter); a menu of 8+ presets is REGISTERED work (minimal-mono, playful, editorial,
   luxe-dark, brutalist, pastel-soft, terminal, aurora-glass).
2. **Typography**: bundled variable woff2 (Inter + Fraunces latin, 83KB, OFL) — reproducible across
   OSes and offline; the serif owns display headlines only.
3. **Blocks** (`src/components/blocks/`, READ-ONLY kit): NavBar, Hero, Section, PageHeader,
   FeatureGrid, MediaCard, StatStrip, EmptyState, Footer + ArtImage. Each <150 lines, cva variants,
   token-only, and a `data-block="<name>"` stamp (survives minification → powers design-lint).
4. **Imagery**: `ArtImage` (seeded FNV-1a → 6 SVG pattern generators; fills ONLY theme tokens → art
   re-colors under any preset/dark mode) + a 770KB curated photo pack with a typed manifest
   (`photo()/photoFor()`). Emoji-as-image is banned.
5. **Gallery = the template demo**: GalleryLanding (a full premium landing from every block — the
   user-facing visual REVIEW GATE artifact, approved before any agent wiring) + GalleryKit (living
   spec). `src/demo/` is deleted by generated apps.
6. **Knowledge wiring**: design SKILL v2 (preset menu, block vocabulary + INLINE workhorse examples,
   one-accent color discipline with explicit substitutes for rating/status colors, imagery decision
   rule, copyable design-pass checklist); generated `reference/blocks.md` (extended genKitReference);
   planner contract gains a seventh **Design** section (cap 1500→1800 chars — ~75 pinned tokens of
   style contract vs hundreds of drift-correction tokens); BUILDER_BEHAVIOR QUALITY BAR line.
7. **Measurement — design-lint** (`eval/builder/_lib/designLint.mjs`): OBJECTIVE bundle assertions —
   no raw color utilities, block assembly via data-block markers, real imagery present, ≥4 emoji
   codepoints = fail, token-baseline positive control. Composed into the shop checks; the emoji
   mandate dropped from fixtures; solutions rewritten as design-system exemplars (`--verify` 4/4).

## Measured (the A/B ladder)

- **First catch:** design-lint flagged the VENDORED KIT itself — stock shadcn ships `text-white` /
  `bg-black/50`; replaced with token utilities. The kit is now token-purer than upstream.
- **design-v2** (first live run): planner emitted a correct Design line; NavBar + ArtImage + tokens
  adopted; visually transformed vs the pre-design baseline. Two lint failures: hand-rolled product
  cards/empty-state (blocks known but reference unfetched) + two decorative raw colors.
  → Fix (skill text only): workhorse block examples INLINED in the skill (models copy inline
  examples; they skip reference fetches) + explicit substitutes ("stars → text-primary, never
  text-amber-*").
- **design-v3**: inline-example adoption proven (ArtImage), but a cross-skill CONFLICT surfaced: the
  architecture skill's layout example named Header.tsx/ProductCard.tsx — the concrete example beat the
  abstract instruction. Fixed by aligning ALL sources of truth (architecture layout+checklist, design
  checklist, planner Components spec) on "never re-implement what a block provides".
- **design-v4**: ✅ solved with the full design-lint clean — blocks adopted (navbar/media-card/
  empty-state in the bundle), photos + ArtImage mixed, zero raw colors. Authoring principle earned: a
  design system for weak models is only as strong as its most concrete example; every skill that shows
  a file layout is a source of truth and they must all agree.

## Anti-overfit guarantees

Data-only changes; activation unchanged (skills route by trigger words; presets picked from user
adjectives, default premium); measurement objective by construction (substring/regex facts about the
bundle — no taste judgments in the harness); blocks are layout scaffolds with slots, not page
templates, so app variety survives.
