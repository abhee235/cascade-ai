# ADR-055 — A first-class skills engine in core (before any skill content ships)

> **Status:** **implemented** 2026-07-06 (user's architectural call, engine-before-content). Core:
> `skills/skills.ts` (loader w/ frontmatter + fallback + later-dir shadowing; tier-aware prompt index;
> Skill tool serving bodies on demand), `SessionOptions.skillDirs`, Skill in the read-only subagent set.
> Wired: server builder sessions + the bench (fidelity). First pack: 7 builder skills (architecture,
> design, data, forms, auth, dashboard, landing) with frontmatter; INDEX.md retired (the engine IS the
> index). 5 engine tests incl. a through-the-real-loop Skill call; suite 299 green. Measurement: shop
> scenario re-runs (label `skills-1`).

## Context

ADR-054 wants builder skills (recipes the model consults). The naive wiring — files in the project + a
prompt line "read INDEX.md" — has three structural flaws: (1) it relies on prompt obedience with no
first-class discovery; (2) immutability needs a sync-and-overwrite hack; (3) it's builder-only — chat
and extension sessions get nothing. Mature agents treat skills as an ENGINE: markdown +
frontmatter (`name`, `description`, `whenToUse`), loaded from directories (bundled + user), surfaced as
a frontmatter-only index (cheap tokens), invoked via a **Skill tool** that injects the content on
demand. Cascade's charter is learning that
algorithm — this is a core-parity piece, not builder plumbing.

## Decision (proposed)

`packages/core/src/skills/` + one tool, deliberately v1-small:

1. **Loader** — `loadSkills(dirs: string[]): Skill[]`: parse `*.md` frontmatter (name, description,
   optional whenToUse); tolerate frontmatter-less files (name = filename, description = first heading).
   Later dirs win on name collision → pass base dirs first, user dirs last = **user skills shadow base
   by name; base files themselves are never writable** (they live in the SERVER package, outside the
   project and outside the Read jail — true immutability, no sync hack).
   **Canonical layout (the established skill convention): `<skill-name>/SKILL.md`** — established loaders
   accept ONLY this directory form from skills dirs; flat `<name>.md` files are a Cascade tolerance for
   quick user notes, not the documented convention. Bundled reference docs live inside the skill folder,
   are LINKED from SKILL.md (the documented rule: one level deep), and are served via `Skill {name, file}`
   — the body stays a lean table of contents. Agent definitions are the opposite convention: single flat
   `.md` files (also the established convention).
2. **Surfacing** — the system prompt gains a tier-aware `Skills` section: one line per skill
   (`name — description`), plus "call the Skill tool BEFORE related work". Frontmatter-only cost
   (the established token model); at `minimal` tier only names.
3. **Invocation** — a `Skill` tool (read-only, concurrency-safe): `{ name }` → returns the skill BODY
   as the tool result. Harness-served content — the path jail is irrelevant by design. Weak-model
   friendly: an explicit tool call, not "please remember to read a path".
4. **Wiring** — `SessionOptions.skillDirs?: string[]`. Server (builder): `[<server>/skills/builder,
   <project>/.cascade/skills]`. Extension (later, free): `[<workspace>/.cascade/skills]`.
5. ADR-054's content (already written: architecture/design/data/forms/auth/dashboard/landing) becomes
   the first bundled skill pack — frontmatter added, INDEX.md replaced by the engine's own surfacing.

## Non-goals (v1)

Isolated per-skill agent budgets, skill hooks, plugins/MCP skills, slash-command surfaces — mature
agents have them; we add them when a measured need appears.

## Verification

Unit: loader (frontmatter, fallback, shadowing order); Skill tool (returns body, unknown name lists
available); prompt section (tier sizing, absent when no dirs). Bench: shop scenarios re-run — the
model should Skill-call design/architecture before building (visible in traces + Phoenix).
