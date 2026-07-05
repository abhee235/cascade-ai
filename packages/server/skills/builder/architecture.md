# Architecture — how every app in this project is structured

## File layout (follow exactly)

```
src/
  App.tsx               ← composition root ONLY: view switching + top-level state. Keep under 100 lines.
  components/ui/        ← the shadcn/ui kit (READ-ONLY — never edit or recreate these)
  components/           ← YOUR components, one per file: Header.tsx, ProductCard.tsx, CartView.tsx…
  lib/                  ← pure logic: types.ts, data.ts (seed data), utils helpers
  hooks/                ← custom hooks when state logic repeats (useCart.ts, useLocalStorage.ts)
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

## Workflow per feature

1. Read `architecture.md` + the matching recipe. 2. Update `lib/types.ts` + `lib/data.ts` first.
3. Build/extend components (small files). 4. Wire into App's view switch. 5. Run `npm run build` — it
must pass before you claim done.
