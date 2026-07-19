---
name: landing
description: Landing-page structure with real copy: hero, feature grid, social proof, pricing cards, CTA rhythm — and a render checklist.
whenToUse: Load when the task mentions ANY of: landing page, home page, marketing site, hero, pricing page, features section, waitlist, coming soon.
---
# Landing pages — structure sells; assemble the blocks, keep the rhythm

## Section order (top to bottom — these are BLOCKS from src/components/blocks/, don't hand-roll them)

1. **`<NavBar>`**: brand left, 2–4 links, one primary `<Button>` in `actions`.
2. **`<Hero>`**: one bold claim (max ~8 words) in `headline`, one supporting line in `subcopy`,
   primary + secondary buttons in `actions`, a photo or `<ArtImage kind="banner">` in `media`
   (`layout="split"` default; `"bleed"` for full-image drama).
3. **`<Section tone="muted">` + `<FeatureGrid>`**: 3 or 6 features — lucide icon, short title,
   two-line description. Never walls of text.
4. **Social proof**: `<Section>` + `<StatStrip>` (big numbers) or a quote `<Card>`.
5. **Pricing** (if asked): `<Section>` + 2–3 `<Card>`s side by side; highlight ONE with
   `border-primary` and a `<Badge>Popular</Badge>`; check-icon feature lists; one `<Button>` each.
6. **Final CTA**: `<Section tone="muted">` — repeat the hero claim shorter + one button.
7. **`<Footer>`**: brand + tagline + link columns + fineprint.

Exact block props + the canonical assembly: `Skill {name: "design", file: "reference/blocks.md"}`.

## Build order — copy this checklist and tick each section only when it RENDERS correctly

```
Landing progress:
- [ ] Nav renders (name + links + one primary button)
- [ ] Hero renders (claim + support line + two buttons)
- [ ] Feature grid renders (3 or 6 cards, real copy)
- [ ] Social proof renders
- [ ] Pricing renders (if requested; one tier highlighted)
- [ ] Final CTA + footer render
- [ ] `npm run build` passes
```

## Rules

- Center content with `mx-auto max-w-5xl px-6`; alternate section backgrounds (`bg-background` /
  `bg-muted`) for rhythm — never colored bands of invented colors.
- ONE primary action per screenful; everything else `variant="secondary"` or `variant="ghost"`.
- All copy concrete ("Ship your store in minutes"), no lorem ipsum — write real, product-specific text.
- Buttons must DO something in the demo (scroll to a section, open a Dialog with a mock signup form —
  see forms.md).
