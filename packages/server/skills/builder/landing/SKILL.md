---
name: landing
description: Landing-page structure with real copy: hero, feature grid, social proof, pricing cards, CTA rhythm — and a render checklist.
whenToUse: Load when the task mentions ANY of: landing page, home page, marketing site, hero, pricing page, features section, waitlist, coming soon.
---
# Landing pages — structure sells; keep the rhythm

## Section order (top to bottom — don't improvise the skeleton)

1. **Nav**: product name left, 2–4 anchor links + one primary `<Button>` right.
2. **Hero**: one bold claim (`text-4xl font-bold tracking-tight`, max ~8 words), one supporting line
   (`text-lg text-muted-foreground`), primary + secondary buttons, generous padding (`py-24`).
3. **Feature grid**: 3 or 6 `<Card>`s — icon (lucide), short title, two-line description. Never walls
   of text.
4. **Social proof**: a quote card or a simple logo/name row (`text-muted-foreground`).
5. **Pricing** (if asked): 2–3 `<Card>`s side by side; highlight ONE with `border-primary` and a
   `<Badge>Popular</Badge>`; per-tier feature list with check icons; one `<Button>` each.
6. **Final CTA**: repeat the hero claim shorter + one button, `py-16`, `bg-muted` band.
7. **Footer**: small, `text-sm text-muted-foreground`, links in columns.

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
