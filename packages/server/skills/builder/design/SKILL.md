---
name: design
description: The design system: theme presets, page blocks, the shadcn/ui kit, tokens, type, and imagery. How to make every screen look DESIGNED, not scaffolded. Includes generated references for the kit and the blocks.
whenToUse: Load when the task mentions ANY of: page, screen, button, card, modal, dialog, menu, input, list, grid, layout, style, color, theme, preset, font, dark mode, icon, image, photo, hero, landing, polish, look and feel. If the task will render anything, load this first.
---
# Design — this project HAS a design system. Compose it; never improvise styling.

## 1. The design system

Tokens (colors, fonts, radius, shadows) live in `src/themes/<preset>.css`; the ACTIVE preset is the one
`@import './themes/….css'` line in `src/index.css`. Components consume tokens via utilities
(`bg-primary`, `text-muted-foreground`…). **Never edit token values, never write raw colors.**

## 2. Theme presets

Installed presets = the files in `src/themes/`. Pick by matching the USER'S adjectives; no match ⇒ keep
`premium` (the default, already active — you change NOTHING for it).

| preset | character — pick when the user says… |
|---|---|
| `premium` | DEFAULT. Refined, elegant, boutique, considered, expensive, editorial-commerce |
| `minimal-mono` | Minimal, monochrome, precise, engineering, developer tool, dashboard, admin, data-heavy |
| `editorial` | Warm, literary, magazine, portfolio, blog, story, calm, print-like |
| `luxe-dark` | Dark, premium, luxury, cinematic, gaming, product launch, "make it dark" |
| `playful` | Fun, friendly, bright, colorful, consumer, food, kids, social |
| `aurora-glass` | Modern SaaS, AI startup, gradient, glassy, futuristic, "like Linear/Vercel" |

To apply a preset — at scaffold time or when the user asks for a different look later — call
`Restyle {op: "preset", preset: "<name>"}`. It rewrites the one `@import` line in `src/index.css` for
you; colors, fonts, radius, shadows and density all follow, and nothing else changes.

Restyle has a second, independent axis: `Restyle {op: "skin", skin: "sharp"}` swaps the block
STRUCTURE (card/nav/hero markup) for certified alternates with identical props — your pages and imports
keep working untouched. `skin: "base"` restores the stock look; `components: ["MediaCard"]` swaps just
one surface. Any preset composes with any skin. Never hand-edit `src/themes/`, the `@import` line, or
`src/components/blocks/` to change a look — Restyle is the mechanism, and the blocks refuse edits anyway.

## 3. Blocks — pages are BLOCK COMPOSITIONS

`src/components/blocks/` (READ-ONLY, like the kit) are the page sections. Assemble pages from blocks
FIRST, then fill their slots with the kit:

- `AppShell` — the chrome for any SIGNED-IN view (sidebar nav + sticky header + content well). A
  dashboard/admin/settings page belongs inside one; a bare centred column reads as a marketing page.
- `NavBar` — every page's header (brand, links, actions). `Hero` — landing headline
  (`layout="split|centered|bleed|collage"`; **collage** layers the image over offset panels — the modern
  depth look, and it needs only ONE image).
- `Section` — every content band (`tone="default|muted|wash"`; **wash** paints a soft gradient field from
  the preset's own colors). `PageHeader` — app-view headers.
- `BentoGrid` — **the modern feature band**: MIXED-weight tiles (`media` anchor + `stat` numbers + ONE
  filled `accent` CTA + `plain`), not a row of identical cards. Reach for this before FeatureGrid on a
  landing page.
- `LogoStrip` — social proof under the hero; plain TEXT wordmarks are the default (zero assets needed).
- `FeatureGrid` — icon+title cards. `MediaCard` — product/article/listing cards. `StatStrip` — big numbers.
- `EmptyState` — the list worked and has no data. `ErrorState` — the list FAILED (`code="404"` for a
  missing route). `SkeletonList` — the list is loading. Three different causes, three different blocks;
  see the `app-shell` skill. `Footer` — landing pages end with one.
- `AuthCard` — sign-in/sign-up, centred, no nav. `SettingRow` — one settings/account row (label left,
  control right), stacked in a `divide-y` card.
- `Photo` — a real photo per item in a grid (see Imagery). `ArtImage` — token-colored SVG art.

**A modern landing reads: Hero(collage) → LogoStrip → Section+BentoGrid → Section+MediaCard grid →
Section(tone="wash") → Footer.** Two-tone headlines are the current idiom — put the second clause in
`<span className="text-muted-foreground">`.

**Never hand-roll a card grid or an empty state — these two are the workhorses, copy them:**

```tsx
import { MediaCard } from '@/components/blocks/MediaCard'
import { EmptyState } from '@/components/blocks/EmptyState'
import { ArtImage } from '@/components/blocks/ArtImage'

<MediaCard media={<ArtImage seed={p.name} kind="product" />} title={p.name} meta={p.category}
  aside={`$${p.price.toFixed(2)}`} onClick={() => open(p)}
  actions={<Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); add(p) }}>Add to cart</Button>} />

{items.length === 0 && <EmptyState icon={ShoppingCart} title="Your cart is empty"
  description="Find something you'll keep." action={<Button variant="outline" onClick={goCatalog}>Browse</Button>} />}
```

Other blocks' exact props + the canonical page assembly: `Skill {name: "design", file: "reference/blocks.md"}`.
For kit components (Dialog, Select, Table…): `Skill {name: "design", file: "reference/components.md"}`.

**The kit is FULL shadcn/ui — 53 components.** Before hand-rolling any interactive control, check the
reference; it is almost certainly already there. The ones models most often rebuild by hand:

| You need | Use — do NOT hand-roll |
|---|---|
| a destructive confirm | `AlertDialog` (never delete on a single click) |
| mobile nav / side panel | `Sheet` · `Drawer` |
| a range or price filter | `Slider` |
| "you are here" nav trail | `Breadcrumb` |
| long lists split up | `Pagination` |
| a ⌘K / search palette | `Command` |
| view switchers | `ToggleGroup` · `ButtonGroup` |
| show/hide a section | `Collapsible` |
| dates | `Calendar` (+ `Popover` = date picker) |
| a scrolling pane | `ScrollArea` |
| a loading spinner | `Spinner` |
| a keyboard hint | `Kbd` |
| a form field + label + error | `Field` · `FieldGroup` |
| an inline empty block | `Empty` (or the `EmptyState` block for a whole view) |

`Sidebar` also exists, but for a signed-in app shell prefer the `AppShell` **block** — it is prop-driven
and already wired. Reach for `Sidebar` only when you need its collapsible/mobile behaviour.

## 4. Color discipline

Token utilities ONLY: `bg-background text-foreground`, `bg-card`, `bg-primary text-primary-foreground`,
`bg-muted text-muted-foreground`, `bg-secondary`, `bg-accent`, `text-destructive`, `border-border`.
NO `bg-blue-600`, no `bg-white`/`bg-black`, no hex, no arbitrary values. **One strong accent**: use
`bg-primary` (default Button) for THE one main CTA per screenful; everything else stays quiet
(`secondary`/`outline`/`ghost`). Charts and decorative variety: `chart-1..5` tokens only.
Common traps — the SUBSTITUTES are: star ratings → `text-primary` (never text-amber-*); success/"in
stock" → `text-primary` or a `<Badge variant="secondary">` (never text-green-*); warnings/errors →
`text-destructive` (never text-red-*).

### Tokens in JS (charts, canvas, inline styles)

Utilities are the normal path. When you MUST pass a colour to JavaScript — recharts, a canvas, an
inline `style` — use the PRESET variable, never the Tailwind alias:

```tsx
fill="var(--chart-1)"   stroke="var(--border)"   background: 'var(--popover)'   // ✅ always defined
fill="var(--color-chart-1)"                                                     // ❌ silently empty
```

Why: `@theme inline` only emits a `--color-*` alias when some generated UTILITY references it. Nothing
uses `bg-chart-1`, so `--color-chart-1` does not exist at runtime and the chart paints black-on-black
(measured, 2026-08-11). The preset variables — `--chart-1..5`, `--primary`, `--accent`, `--border`,
`--popover`, `--muted-foreground`, `--radius` — are declared by the theme file itself and always resolve.
`<ChartCard>` already does this for you; follow it if you ever drop to a raw chart.

## 5. Type & rhythm

Display headlines (Hero, Section headings): `font-serif tracking-tight` — the serif is the personality;
don't use it for body text. App views cap at `text-3xl`; only Hero goes `text-4xl/5xl`. Body = default
sans. Muted small (`text-sm text-muted-foreground`) for meta/captions. Spacing: blocks encode the rhythm
(Section = `py-16/20`, container `max-w-6xl px-6`) — don't fight it with custom margins; inside cards
use `flex flex-col gap-*`, never margin stacks.

## 6. Imagery — never an emoji, never a gray box

**IMAGERY ROUTING (the rule of thumb):** a grid/list of distinct items → `<Photo web="<subject keywords>"
seed={item.id} kind="product">` (each card gets a distinct real photo) · a single hero/banner →
`photo()`/`photoFor()` · abstract covers/avatars/decorative → `<ArtImage>`. Details and the why below.

Choose by what the subject needs — don't default to abstract art when a real photo would sell it:

- **Bundled photos** (fast, offline, curated) — for **ONE or TWO big images**: a hero, a section banner,
  a lifestyle shot. `import { photo, photoFor } from '@/lib/photos'`; `photo('nature-mountain')` or
  `photoFor(seed, 'food')` (categories: food, product, workspace, nature, interior, people, texture).
  ⚠️ **The pack holds only ~2 photos PER CATEGORY.** So `photoFor` on a **grid of distinct items** makes
  every card show one of the same two pictures — the "why do all my products look like the same watch?"
  bug. NEVER map a catalog/list through `photoFor`; use `<Photo web>` (below) so each item is distinct.
- **Real web photos — the DEFAULT for any grid/list/catalog of distinct subjects.** When the subject needs
  REAL photography the small bundled pack can't cover (an **e-commerce catalog of real products**,
  travel/real-estate/recipe listings): use the
  `<Photo>` block — `import { Photo } from '@/components/blocks/Photo'` →
  `<Photo web="leather watch minimal" seed={p.name} kind="product" />`. `web` = space-separated keywords
  for the subject; it pulls a real, deterministic photo from an **allowlisted, hotlink-safe source**,
  **retries once**, and then **auto-falls back to `<ArtImage>`** — so never a broken box. Only the
  allowlisted hosts are reachable (enforced in `photos.ts` — do NOT hand-write external image URLs).
  Prefer this over `<ArtImage>` for product grids/detail pages; it makes a store look real, not abstract.
  ⚠️ **Keyword matching is DECORATIVE ONLY — it is not a catalog tool.** It returns a loosely-related photo
  even when it works (measured on real builds: `"cordless drill"` rendered a person at a laptop, `"utility
  blades"` a bowl of food), and on 2026-09-27 its host answered **401 to every request**, so it may produce
  no photo at all. `<Photo>` then falls back to a real-but-random photo, and only then to `<ArtImage>`.
- **`ImageSearch` is the way to get a photo that MATCHES ITS LABEL** — a product catalog, a named-dish menu.
  Call it, then pass the URL it returns straight through: `<Photo web="https://…" seed={p.name} />` accepts
  a URL as readily as keywords. **Search 2-3 concrete nouns** (`coffee beans`, `cordless drill`): the index
  AND-matches every word, so a long descriptive phrase like `"coffee beans bag Ethiopia natural roast
  photography"` matches **nothing** (measured: 0 results, vs 240 for `coffee beans`). Search once per
  product or per category and store the URLs on your seed data.
- **Generated art** (no real subject fits — abstract covers, avatars, decorative): `<ArtImage seed={name}
  kind="product" />` — same seed always renders the same token-colored art, in every preset and dark mode.
- An emoji is never an image. An empty `bg-muted` box is never an image.
- Storing a bundled photo name on your data? The type ALREADY EXISTS: `import type { PhotoName } from
  '@/lib/photos'`. Never re-declare it or invent keys from memory — hand-typed name unions drift from the
  real assets and break the build. (For `<Photo web>` you pass free-text keywords, not a PhotoName.)

## 7. Dark mode

Toggle the `dark` class on `document.documentElement`; persist in localStorage. Every token, block, and
ArtImage adapts automatically — if something looks wrong in dark, you used a raw color; fix the color.

## 8. States & feedback

Every list view has FOUR states, and the wrong one is a lie the user acts on: `<SkeletonList>` while
loading, `<ErrorState>` when the request FAILED (its action retries), `<EmptyState>` when it succeeded
with no data (its action creates), and data. Check them in that order — `items.length === 0` first
renders "nothing here" during every load and after every failure. Plus: feedback after actions
(toast/inline text), and disabled buttons for invalid actions (not error popups after the click).
The `app-shell` skill has the full pattern, including 404s and filtered-empty.

## Design pass — run this checklist before calling any UI work done

- [ ] Page assembled from blocks (NavBar + Hero/PageHeader + Sections + Footer where it's a landing)
- [ ] Zero raw colors in your diff (no bg-white/black, -500/-600 shades, hex — stars/stock/success = text-primary)
- [ ] Every image is photo()/photoFor()/<Photo>/<ArtImage> — zero emoji-as-image; any GRID/LIST of distinct items uses `<Photo web="<subject>" seed={item.id}>` (distinct per item), NEVER photoFor (repeats) or abstract art
- [ ] Opened the grid in the Browser and COUNTED: no two cards share a photo, and each photo matches its label
      (any card showing abstract art or an off-subject photo ⇒ swap THAT item to an `ImageSearch` URL, don't shrug)
- [ ] Exactly one bg-primary CTA per screenful; every list handles loading/error/empty, not just data
- [ ] Checked once in light AND dark mode before done
