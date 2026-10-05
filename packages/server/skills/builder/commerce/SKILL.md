---
name: commerce
description: Shops end to end — catalog grid, product detail, cart with a live badge, checkout that validates, and the order confirmation. The block set, the state shape, and the numbers a store must hit before it is done.
whenToUse: Load BEFORE building any shop, store, e-commerce, catalog, product listing, cart, checkout, pricing-by-item, marketplace, booking, or "sell X online" app. Also when the user says the cart or checkout is broken.
---
# Commerce — a shop is four views and one piece of state

The failure mode is never "it does not compile". It is a catalog that renders and a cart that does not
add, or a checkout that accepts an empty form. Build the four views, wire the ONE state object, then
verify against the numbers at the bottom of this file.

## The contract — a shop is DONE when all four exist and connect

| View | Must contain | Reachable from |
|---|---|---|
| **catalog** | ≥6 products in a grid, each with a DISTINCT photo, name, price, add-to-cart | the nav / landing |
| **detail** | large image, name, price, description, add-to-cart, back to catalog | clicking a card |
| **cart** | one `<CartRow>` per line (stepper + remove + line total), order total, checkout button, `<EmptyState>` when empty | the header cart button |
| **checkout** | required fields with on-submit validation, then a confirmation showing the order total | the cart's checkout button |

A shop missing the confirmation is a shop where the user cannot tell whether they bought anything.

## State — ONE object, derived everywhere else

```tsx
// src/lib/types.ts
export interface Product { id: string; name: string; price: number; description: string; category: string }
export interface CartLine { productId: string; quantity: number }

// App.tsx — cart is the ONLY cart state. Everything else is derived.
const [cart, setCart] = useState<CartLine[]>([])
const lines = useMemo(() => cart.map((l) => ({ ...l, product: CATALOG.find((p) => p.id === l.productId)! })), [cart])
const total = useMemo(() => lines.reduce((s, l) => s + l.product.price * l.quantity, 0), [lines])
const count = useMemo(() => cart.reduce((s, l) => s + l.quantity, 0), [cart])   // the NavBar badge

const add = (id: string) => setCart((c) => (c.some((l) => l.productId === id)
  ? c.map((l) => (l.productId === id ? { ...l, quantity: l.quantity + 1 } : l))
  : [...c, { productId: id, quantity: 1 }]))
const setQty = (id: string, delta: number) =>
  setCart((c) => c.flatMap((l) => (l.productId !== id ? [l] : l.quantity + delta < 1 ? [] : [{ ...l, quantity: l.quantity + delta }])))
```

Never store `total`, `count`, or the joined product — they are `useMemo`, always. A stored total drifts
from the cart the first time a quantity changes, and that bug is invisible until a user complains.

The FULL working shop — all four views, the state flow, the derived totals — is one call away:
`Skill {name: "commerce", file: "reference/pages.md"}`. It is the verbatim source of a page that renders,
so it cannot drift from reality. Read it when a view fights you; copy its SHAPE, never its copy or data.

## The page assembly — copy this shape

```tsx
// App.tsx — view union + cart state; every view is a component in src/components/
const [view, setView] = useHistoryView<View>('catalog')   // 'catalog' | { kind:'detail', id } | 'cart'

<NavBar
  brand={<Logo name="Harbor & Pine" />}   // your app's name, set as the brand
  links={<><button onClick={() => setView('catalog')}>Shop</button></>}
  actions={<Button variant="outline" onClick={() => setView('cart')}>
    <ShoppingCart className="size-4" /> Cart {count > 0 && <Badge className="ml-1">{count}</Badge>}
  </Button>}
/>

{/* CATALOG — <Photo web> per item so every card is a DISTINCT real photo */}
<Section eyebrow="The collection" heading="Everything in stock">
  <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
    {CATALOG.map((p) => (
      <MediaCard key={p.id} onClick={() => setView({ kind: 'detail', id: p.id })}
        media={<Photo web={p.name} seed={p.id} kind="product" />}
        title={p.name} meta={p.category} aside={<span className="font-medium">${p.price.toFixed(2)}</span>}
        actions={<Button size="sm" onClick={(e) => { e.stopPropagation(); add(p.id) }}>Add to cart</Button>} />
    ))}
  </div>
</Section>

{/* CART */}
{lines.length === 0
  ? <EmptyState icon={ShoppingCart} title="Your cart is empty" description="Find something you'll keep."
      action={<Button variant="outline" onClick={() => setView('catalog')}>Browse the collection</Button>} />
  : lines.map((l) => (
      <CartRow key={l.productId} media={<Photo web={l.product.name} seed={l.productId} kind="product" />}
        title={l.product.name} unitPrice={`$${l.product.price.toFixed(2)}`} quantity={l.quantity}
        lineTotal={`$${(l.product.price * l.quantity).toFixed(2)}`}
        onQuantityChange={(d) => setQty(l.productId, d)} onRemove={() => setQty(l.productId, -l.quantity)} />
    ))}

{/* CHECKOUT — validate ON SUBMIT (forms skill), then swap the form for the confirmation */}
<CheckoutPanel
  lines={[{ label: 'Subtotal', value: `$${total.toFixed(2)}` }, { label: 'Shipping', value: 'Free', muted: true }]}
  total={`$${total.toFixed(2)}`}
  action={<Button type="submit">Place order — ${total.toFixed(2)}</Button>}
  confirmation={placed ? <EmptyState title="Order confirmed" description={`Thank you! Your total was $${placed.toFixed(2)}.`} /> : undefined}
>
  {/* Label + Input pairs; see the forms skill for the error pattern */}
</CheckoutPanel>
```

## Imagery — the one rule that decides whether a shop looks real

`<Photo web="<subject keywords>" seed={p.id} kind="product" />` per card. NEVER `photoFor()` in a
`.map()` — the bundled pack holds ~2 photos per category, so every product shows the same picture (this
is measured, and it is the single most obvious "AI built this" tell in a storefront).

## Acceptance — check each before you call it done

- [ ] Catalog renders **≥6** products; open it and COUNT the images — no two cards share a photo.
- [ ] Clicking a card opens detail; a back control returns to the catalog (both via `useHistoryView`).
- [ ] Add-to-cart from BOTH catalog and detail increments the header badge.
- [ ] Cart: `+`/`−` change the line total AND the order total; remove drops the line; empty shows `<EmptyState>`.
- [ ] Checkout with an EMPTY form does not submit — each missing field shows its own message.
- [ ] Submitting shows a confirmation containing the order total.
- [ ] `npm run build` green → `TemplateAudit` clean → `Browser {op:"open"}` → `Browser {op:"audit"}` clean.

## Out of scope unless asked

Payments, accounts, inventory, discount codes, shipping calculation. A prototype shop persists in the
browser via `src/lib/storage.ts`; if the user asks to persist orders on a server, load the `backend`
skill and call `ApplyPack` — never hand-roll a server.
