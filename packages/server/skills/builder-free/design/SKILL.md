---
name: design
description: Designing a blank project from scratch — the direction (palette, type, density, imagery), the brand as a wordmark, the theme tokens every component uses, one spacing system, composition that fills its sections, and the checks before done. Freedom with discipline.
whenToUse: Load when the task mentions ANY of: page, screen, button, card, modal, dialog, menu, input, list, grid, layout, style, color, theme, font, dark mode, icon, image, photo, hero, landing, logo, spacing, polish, look and feel. If unsure whether to load it: load it.
---
# Design — a blank project: you design it, and you design it with discipline

There is no kit, block library or preset here. The look is yours to decide — and what makes it read as
DESIGNED rather than generated is the same everywhere: a clear direction, ONE token system, ONE spacing
system, sections that are full of the subject, and a final look at the running app.

## 1. The direction (PLAN.md's Design line records it)
- Ground it in the subject: what does this business sell, to whom, in what mood? A roastery is not a SaaS.
- If the user attached images, they ARE the direction: take their palette, type character, layout and density.
- Decide, and write down: `mood` (3 words) · `palette` (background, text, primary/CTA, accent, surface, muted,
  border, and inverse if any band is in the opposite value — hex) · `type` (a display face and a body face) ·
  `density` (dense / standard / spacious) · each view's layout · `imagery`. (The brand is the name set as a
  wordmark, §6 — nothing to decide.)
- Refuse the reflexes (§9): the palette and faces are choices for THIS subject.

## 2. Tokens — one theme file, used everywhere
Every color, font, radius and spacing step is a CSS variable in `src/theme.css`, mapped into Tailwind v4 so
components use utilities like `bg-background text-foreground bg-primary text-primary-foreground border-border`.
Components NEVER use raw hex, `bg-white`, `text-gray-600` or other palette classes. A band in the OPPOSITE value —
a dark strip, hero panel or button on a light page, or the reverse — is the `inverse` role (`bg-inverse
text-inverse-foreground`), never the text color pasted as a hex: measured, an app built from a reference image
hard-coded 35 of its surfaces that way, and none of them could follow `.dark`.

```css
/* src/theme.css — imported by src/index.css after `@import "tailwindcss";` */
@custom-variant dark (&:is(.dark *));
:root {
  --background: #faf7f2; --foreground: #1f1a14;
  --surface: #ffffff; --surface-foreground: #1f1a14;
  --muted: #efe8dd; --muted-foreground: #5f5347;
  --primary: #9a3f1e; --primary-foreground: #ffffff;
  --accent: #2f5d50; --accent-foreground: #ffffff;
  --inverse: #1f1a14; --inverse-foreground: #faf7f2;
  --border: #e4dccf; --ring: #9a3f1e; --radius: 0.75rem;
  --font-display: 'Fraunces Variable', serif; --font-body: 'Inter Variable', sans-serif;
  --section-y: 4rem; --hero-y: 6rem; --content-w: 72rem;   /* density: standard (§3) */
}
.dark { --background: #16120e; --foreground: #f3ede4; --surface: #201a15; /* …every color role again */ }
@theme inline {
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-surface: var(--surface); --color-surface-foreground: var(--surface-foreground);
  --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-accent: var(--accent); --color-accent-foreground: var(--accent-foreground);
  --color-inverse: var(--inverse); --color-inverse-foreground: var(--inverse-foreground);
  --color-border: var(--border); --color-ring: var(--ring);
  --font-display: var(--font-display); --font-body: var(--font-body);
  --radius-lg: var(--radius); --spacing-section: var(--section-y); --spacing-hero: var(--hero-y);
}
```
Fonts: `npm install @fontsource-variable/<name>` and `import '@fontsource-variable/<name>'` in `src/main.tsx`;
the family is `'<Name> Variable'`. No runtime font CDN.

## 3. Spacing — one system, so the page has a rhythm
- One scale: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 px. Nothing off-scale.
- Density sets two steps: `--section-y` (dense 2.5rem · standard 4rem · spacious 6rem) and `--hero-y` (one step up).
- EVERY top-level section gets exactly `py-section` — the only vertical padding it has. The hero gets `py-hero`.
  No section adds its own `py-24`, no wrapper inside a section adds vertical padding, no margins between sections.
- One content width for header, every section and footer: `mx-auto max-w-(--content-w) px-6`. The logo and the
  page content line up on every view.
- A band whose content is thin (one quote, one row of logos) is the exception: it takes half the step — or merges
  into its neighbour. Big empty space around little content reads as unfinished, never as "airy".

## 4. Composition — sections full of the subject
- The hero shows the THING: the product, the dish, the dashboard, the place — a real photo or a realistic mock,
  large. Headline + subline + one primary action + one quiet action.
- Every section carries a visual anchor: a product visual, a real photo, a data view, a mock, an illustration.
  No tile, card or band is mostly empty.
- Vary the layouts down the page: split (copy beside visual), grid, full-bleed image band, stats row, a bento
  whose every tile has content. Alternate alignment. Do not open every section with the same small label +
  heading + grey line.
- Specific copy beats generic copy: real numbers, real product names, the subject's own words.

## 5. Type
- Display face for headings (and the logo), body face for everything else. A clear scale:
  12 · 14 · 16 · 18 · 24 · 32 · 48 · 64 px. Body 16–18 px, line length ≤ 70ch, headings tight (leading 1.05–1.15).

## 6. The brand — the name, set well
A small `src/components/Logo.tsx`: the app's name — or its short form — as a WORDMARK in the bold display face,
with ONE deliberate detail in the primary color (the last word, a letter, or a dot). No icon mark: a logo is
personal — the owner brings their own — and never a stock icon beside plain text.

## 7. Imagery and icons
- Real photos of each subject: the ImageSearch tool returns verified URLs — one DISTINCT photo per product or
  item, descriptive `alt`. Or drawn illustration. Never emoji as images, never a grey box, never a
  random-photo host (picsum, loremflickr).
- UI icons: `lucide-react`. Never glyphs (✦ ★ ✓ → ●) as icons.

## 8. Color, contrast, dark mode
- Text 4.5:1 against its real background, large text and UI edges 3:1. Every role used as TEXT — `primary`
  (links, labels), `accent`, a status color — must reach 4.5:1 on background, surface and muted IN BOTH MODES
  (a saturated accent usually needs a lighter tint in `.dark`), and `primary` carries its own label at 4.5:1.
- On a colored band (primary or accent) every line uses the band's `-foreground` at full strength: secondary lines
  differ by size or weight, never by opacity — `text-primary-foreground/70` on a saturated band lands near 4:1.
- `.dark` redefines every color role; toggling `dark` on `<html>` must restyle the whole app.
- A button on a colored band must be legible there: never a white button with white text on a band.

## 9. The never-list (the default "generated" looks)
An ALL-CAPS label over every heading · an accented phrase in every headline · `→` on button labels · "A · B · C"
meta strings · glyph icons · real companies (Stripe, Vercel, Notion…) presented as your customers · identical
card grids in every section · cream + serif + terracotta by reflex · near-black + one acid accent by reflex.

## Design pass — before calling any UI done
- [ ] `npm run build` green; Browser {op:"open"} loads; Browser {op:"audit"} clean.
- [ ] With vision: screenshot every main view and LOOK — even rhythm? every section anchored? the name set as a wordmark?
- [ ] No raw colors in components; `.dark` restyles everything; contrast AA as in §8.
- [ ] At 390 px wide: no horizontal scroll, no overlapping controls.
- [ ] Every image loads and shows its own subject.
