---
name: browser
description: Verify the RUNNING app with the Browser tool — accessibility snapshots for structure, screenshots for visual judgment, before calling the build done.
whenToUse: After `npm run build` passes and before you declare the app finished. Also when the user reports something looks wrong or broken in the preview.
---
# Browser — look at what you built

The build passing means the code COMPILES. It does not mean the app renders, looks designed, or that
its main flow works. The Browser tool opens the live preview so you can verify all three.

## The smoke pass — run this once per build, after `npm run build` is green

```
Smoke:
- [ ] 1. Browser {op:"open"}                     — loads the app (starts the dev server if needed)
- [ ] 2. Browser {op:"snapshot"}                 — READ the tree: are the nav, headings, lists, buttons there?
- [ ] 3. Browser {op:"screenshot"}               — LOOK at it against the design checklist below
- [ ] 4. Fix what you saw; build; re-check the one thing you fixed
```

## Judging a screenshot — write a verdict for EVERY line

"Looks good / looks clean / looks great" is NOT a verdict — it is how you MISS things. For each item
below, write one concrete sentence naming what you actually see. If you can't point to specific pixels,
you didn't look. A screenshot with zero problems named is a screenshot you wasted.

- **Imagery — the #1 miss.** COUNT the distinct images. Do any repeat across different cards/items? Does
  each image actually MATCH its label (a "Ratatouille" card must not show a noodle bowl)? Repeated or
  mismatched photos are a bug even when each image loads fine — fix the data/`photoFor` mapping so every
  item gets a distinct, on-topic image. (No broken-icon ≠ good imagery.)
- **Consistency across states.** Put the variants side by side: do all the difficulty/status BADGES share
  one style (all solid, or all outline — not "Medium" solid-purple next to "Hard" white-outline)? Do all
  cards share one height, radius, shadow? Drift between siblings is the tell.
- **Composed from blocks** — real NavBar/hero/cards, not unstyled text or hand-rolled boxes.
- **Token colors only** — no raw white/black boxes, no default-blue links.
- **One primary CTA** per screen; empty states show a designed EmptyState, not blank space.
- **Spacing & alignment** — consistent gaps, nothing clipped, cramped, or overflowing.

After writing the verdicts, FIX every problem you named, then re-check the one you fixed.

## Rules

- `snapshot` (text) is the DEFAULT check — cheap. `screenshot` is for VISUAL judgment only and is
  budgeted (a few per session): never screenshot twice in a row without changing something.
- `open` first, always; navigate with `open {path:"/route"}`.
- The origin is fixed to the app's own preview — there is nothing else to browse.
- A dev-server error from `open` means the app CRASHES at runtime: read the error, fix, rebuild.
