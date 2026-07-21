---
name: data
description: Seed catalogs, computed totals/counts, combined search plus filter, and the localStorage persistence hook.
whenToUse: Load when the task mentions ANY of: products, items, catalog, list of X, search, filter, sort, total, count, price, quantity, save, persist, remember after refresh.
---
# Data — catalogs, persistence, derived values (client-side patterns)

## Seed data lives in `src/lib/data.ts`, typed in `src/lib/types.ts`

```ts
// types.ts
export interface Product { id: number; name: string; price: number; category: string; emoji: string }
// data.ts
export const PRODUCTS: Product[] = [ { id: 1, name: 'Trail Backpack', price: 89, category: 'Gear', emoji: '🎒' }, /* 6+ realistic entries */ ]
```

Make seed data REALISTIC (varied names/prices/categories) — it is the demo the user sees.

## Collections keyed by id; derived values computed, never stored

```ts
const [cart, setCart] = useState<Record<number, number>>({})            // id → quantity
const count = useMemo(() => Object.values(cart).reduce((a, b) => a + b, 0), [cart])
const total = useMemo(() => Object.entries(cart).reduce((s, [id, q]) =>
  s + (PRODUCTS.find(p => p.id === +id)?.price ?? 0) * q, 0), [cart])
```

Update immutably; removing = delete the key when quantity hits 0. Money display: ALWAYS
`price.toFixed(2)`.

## Search + filter combine as one derived list

```ts
const shown = useMemo(() => ITEMS.filter(i =>
  (cat === 'All' || i.category === cat) &&
  i.name.toLowerCase().includes(query.toLowerCase())), [cat, query])
```

## Persistence — TWO tools, use the right one

**Collections of entities (recipes, products, tasks) → `createStore` from `@/lib/storage`.** This is
THE seam: it starts localStorage-backed, and if the app later grows a backend it swaps to an API with
zero changes to your views. NEVER read/write `localStorage` for a collection directly in a view.

```ts
// src/lib/storage.ts already exists (the seam). Create ONE store per collection, at module scope:
import { createStore } from '@/lib/storage'
import { SEED_RECIPES } from '@/lib/data'
export const recipeStore = createStore<Recipe>('recipes', SEED_RECIPES)

// Wrap it in a hook so components get reactive state + actions:
export function useRecipes() {
  const [recipes, setRecipes] = useState(() => recipeStore.list())
  const add = (r: Recipe) => { recipeStore.create(r); setRecipes(recipeStore.list()) }
  const edit = (id: Recipe['id'], patch: Partial<Recipe>) => { recipeStore.update(id, patch); setRecipes(recipeStore.list()) }
  const remove = (id: Recipe['id']) => { recipeStore.remove(id); setRecipes(recipeStore.list()) }
  return { recipes, add, edit, remove }
}
```

Store API: `list() · get(id) · create(item) · update(id, patch) · remove(id) · replaceAll(items)`.
Entities need a stable `id`.

**Scalar preferences (theme, an open flag) → a tiny `useLocalStorage` hook.** Not a collection, no seam:

```ts
function useLocalStorage<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial } catch { return initial } })
  useEffect(() => localStorage.setItem(key, JSON.stringify(v)), [key, v])
  return [v, setV] as const
}
```
