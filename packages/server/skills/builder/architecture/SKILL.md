---
name: architecture
description: The mandatory structure rules: file layout, view switching, state placement, the per-feature checklist. Non-negotiable before writing code.
whenToUse: ALWAYS load before the FIRST file write of any session, and again before any new page, view, feature, or refactor. If unsure whether to load it: load it.
---
# Architecture — how every app in this project is structured

## File layout (follow exactly)

```
src/
  App.tsx               ← composition root ONLY: view switching + top-level state. Keep under 100 lines.
  components/ui/        ← the shadcn/ui kit (READ-ONLY — never edit or recreate these)
  components/blocks/    ← the page-section blocks: NavBar, Hero, MediaCard… (READ-ONLY — compose via props)
  components/           ← YOUR view-level components, one per file: CatalogView.tsx, CartView.tsx, CheckoutForm.tsx…
                          NEVER re-implement a block here: page header → <NavBar>, product/listing card →
                          <MediaCard>, empty message → <EmptyState> (import from @/components/blocks)
  lib/                  ← pure logic: types.ts, data.ts (seed data), photos.ts (bundled imagery)
  hooks/                ← custom hooks when state logic repeats (useCart.ts, useLocalStorage.ts)
  demo/                 ← the starter showcase — DELETE this dir (and rewrite App.tsx) when building the real app
```

**Hard rule: no file over ~150 lines.** When a file grows, extract a component. Small files keep your
own reads and edits cheap and precise.

## Views without a router

One `view` state at the top, a discriminated union, and a switch in App:

```tsx
type View = { kind: 'list' } | { kind: 'detail'; id: number } | { kind: 'cart' }
const [view, setView] = useState<View>({ kind: 'list' })
```

Pass `setView` down (or wrap in handlers like `openDetail(id)`). Never reach for a router or a new
dependency — view switching covers everything these apps need.

## State placement

- Shared state (cart, user, theme) lives in App (or a custom hook App calls); pass down via props.
- Local state (an input's text, an open/closed flag) lives in the component that owns it.
- Derived values (totals, counts, filtered lists) are computed with `useMemo` — NEVER stored as state.

## Workflow per feature — copy this checklist into your response and tick it as you go

```
Feature progress:
- [ ] 1. Skills read (this one + the matching recipe for the feature)
- [ ] 2. Types + seed data updated (lib/types.ts, lib/data.ts)
- [ ] 3. Components built/extended (small files, composed FROM blocks + kit — no hand-rolled cards/headers/empty states)
- [ ] 4. Wired into App's view switch
- [ ] 5. `npm run build` passes
```

Success criteria per step — do not move on until met:
1. You can name which recipe applies (design/data/forms/auth/dashboard/landing).
2. Every field the views need exists on the interfaces; seed data is realistic.
3. Each new component imports from `@/components/ui`, is under ~150 lines, and owns one concern.
4. Every new view is reachable from the UI (a button/link switches to it) — no orphan screens.
5. **The feedback loop**: run `npm run build`; if it fails, read the FIRST error, fix that one thing,
   run again. Only proceed — and only claim done — when it passes.
