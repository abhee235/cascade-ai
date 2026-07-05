# ADR-054 — Builder design system + skills: ship the taste, don't hope for it

> **Status:** accepted 2026-07-06 with user decisions: (1) build ALL app-type recipes (CRUD, dashboard,
> landing, forms, auth-mock); (2) base skills are GLOBAL to the server and immutable to users/models —
> synced read-only into each project on open; users add their OWN skills alongside,
> editable later from the web UI; (3) the design system is **shadcn/ui vendored into the template**, not
> bespoke primitives — the decisive argument: models know shadcn from training ("we use shadcn, don't
> hand-roll buttons" activates strong priors; hosted builders are shadcn-based too). Offline safety is preserved by
> the existing shared-deps install.

## Context — the measured problem

The builder template ships a bare Vite+React scaffold and a behavior prompt. Everything else — visual
design, component architecture, data patterns, form handling — the model must produce from its own
weights, from scratch, per app. shop-iterate-1 showed the cost: a 365-line monolith App.tsx, hand-rolled
Tailwind soup, no design tokens, edit grind against its own bloat. The model *works* hard; it just has
nowhere to stand.

Hosted app builders do not ask their models to know design. They ship it:
- a COMPONENT KIT the model composes instead of invents (shadcn/ui — the model writes `<Card>`,
  not 40 utility classes);
- DESIGN TOKENS (palette, spacing, radius, type scale) so every screen is consistent by construction;
- ARCHITECTURE CONVENTIONS (file layout, state patterns) baked into prompt + starter;
- RECIPES for the patterns every visual app repeats (CRUD, forms+validation, auth mock, persistence).

Most visual apps are the same app wearing different clothes. The knowledge is finite and writable.

## Decision (proposed)

1. **The template ships a mini design system** (`src/components/ui/`): ~8 pre-built primitives —
   Button, Card, Input, Badge, Modal, EmptyState, Header, Stat — styled from CSS design tokens
   (`src/index.css`: palette incl. dark mode, spacing/radius/type scale). Small, readable, composable.
   The model IMPORTS them; it stops hand-rolling. (Also attacks the monolith trap at the root:
   components exist, so composition is the path of least resistance.)
2. **Builder skills as FILES in the template** (`.cascade/skills/`): compact recipe docs —
   `architecture.md` (file layout, view switching, state placement), `design.md` (how to use the
   tokens/kit, layout patterns, empty/loading/error states), `data.md` (catalogs, localStorage
   persistence, derived state), `forms.md` (validation, submit flows), `auth.md` (mock-auth pattern).
   Each under ~80 lines. **Progressive disclosure, the established skills pattern:** the system prompt
   carries only a two-line INDEX ("skills exist at .cascade/skills — read the relevant one before
   building X"); the model Reads what the task needs. Window-friendly by design (our read caps keep the
   bites sane; small windows aren't forced to swallow a mega-prompt).
3. **BUILDER_BEHAVIOR gains three lines**: consult the skill index first; compose `components/ui`
   primitives instead of raw markup; follow the token system (never invent colors).
4. **The check evolves**: builder scenarios can assert kit usage (bundle carries the tokens/classes) so
   "ignored the design system" is a measurable failure, not a vibe.

## Why files-on-disk beats one global mega-prompt

- Fits ANY window: the 200k-window approach (everything in the system prompt) dies at 16k. Files +
  index + on-demand reads scale down — and our whole compaction/read-bite stack already manages them.
- Editable by the user per template/project — the "continuously feed" the user asked for is just
  editing markdown, no code.
- Extends to future templates (dashboard template, landing template) by swapping the skills folder.

## Measurement plan

Re-run `builder-shop` (one-shot) + `builder-shop-iterate` on the upgraded template. Expect: less
generated code (composition), multi-file architecture from round 1, consistent styling (tokens in the
bundle), faster rounds (fewer chars written per feature), no monolith by round 2. The visual bar: open
the built app and it should not look like a default-Tailwind homework project.

## Skills placement (user decision — global, immutable base)

- Base skills live in the SERVER package (`packages/server/skills/builder/*.md`) — versioned with the
  product, not the project. On every project OPEN the server SYNCS them into
  `<project>/.cascade/skills/base/` (overwrite): the model reads them through the normal Read jail, and
  any user/model tampering is reset on next open — pragmatic immutability with zero new tool surface.
- User skills: `<project>/.cascade/skills/*.md` (outside `base/`) — never touched by the sync; the
  index tells the model to consult them too. Web-UI editing comes later.
- The bench (`builder.mts`) performs the same sync — fidelity rule: bench sessions = product sessions.

## Non-goals (v1)

- No real auth/backend — recipes cover MOCK patterns only (client-side stores).
- No design-skill autogeneration; the taste is hand-written once, versioned with the server.
- No shadcn CLI at project-create time — components are vendored into the template ONCE at development
  time (they are plain source files); projects scaffold instantly and offline as before.
