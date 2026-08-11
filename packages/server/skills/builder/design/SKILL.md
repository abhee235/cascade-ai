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

To apply a different preset: edit the ONE `@import './themes/….css'` line in `src/index.css`. That is
the entire operation — colors, fonts, radius, and shadows all follow.

## 3. Blocks — pages are BLOCK COMPOSITIONS

`src/components/blocks/` (READ-ONLY, like the kit) are the page sections. Assemble pages from blocks
FIRST, then fill their slots with the kit:

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
- `EmptyState` — REQUIRED for every list's empty case. `Footer` — landing pages end with one.
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

## 4. Color discipline

Token utilities ONLY: `bg-background text-foreground`, `bg-card`, `bg-primary text-primary-foreground`,
`bg-muted text-muted-foreground`, `bg-secondary`, `bg-accent`, `text-destructive`, `border-border`.
NO `bg-blue-600`, no `bg-white`/`bg-black`, no hex, no arbitrary values. **One strong accent**: use
`bg-primary` (default Button) for THE one main CTA per screenful; everything else stays quiet
(`secondary`/`outline`/`ghost`). Charts and decorative variety: `chart-1..5` tokens only.
Common traps — the SUBSTITUTES are: star ratings → `text-primary` (never text-amber-*); success/"in
stock" → `text-primary` or a `<Badge variant="secondary">` (never text-green-*); warnings/errors →
`text-destructive` (never text-red-*).

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
  for the subject; it pulls a real, deterministic photo from an **allowlisted, hotlink-safe source** and
  **auto-falls back to `<ArtImage>`** if the image is blocked or slow — so never a broken box. Only the
  allowlisted hosts are reachable (enforced in `photos.ts` — do NOT hand-write external image URLs).
  Prefer this over `<ArtImage>` for product grids/detail pages; it makes a store look real, not abstract.
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

Every list view needs: an EmptyState (`<EmptyState icon title description action/>` — always one useful
CTA), feedback after actions (toast/inline text), and disabled buttons for invalid actions (not error
popups after the click).

## Design pass — run this checklist before calling any UI work done

- [ ] Page assembled from blocks (NavBar + Hero/PageHeader + Sections + Footer where it's a landing)
- [ ] Zero raw colors in your diff (no bg-white/black, -500/-600 shades, hex — stars/stock/success = text-primary)
- [ ] Every image is photo()/photoFor()/<Photo>/<ArtImage> — zero emoji-as-image; any GRID/LIST of distinct items uses `<Photo web="<subject>" seed={item.id}>` (distinct per item), NEVER photoFor (repeats) or abstract art
- [ ] Opened the grid in the Browser and COUNTED: no two cards share a photo, and each photo matches its label
- [ ] Exactly one bg-primary CTA per screenful; empty lists show <EmptyState>
- [ ] Checked once in light AND dark mode before done
