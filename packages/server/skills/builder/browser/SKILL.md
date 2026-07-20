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

## Judging a screenshot — the checklist

- Composed from blocks? (real NavBar/hero/cards — not unstyled text)
- Token colors only — no raw white/black boxes, no default-blue links
- Real imagery (photos/ArtImage) — no broken-image icons, no empty gray boxes
- One primary CTA per screen; empty states show a designed EmptyState, not blank space
- Name problems CONCRETELY ("the cards repeat the same photo", "the badge styles are inconsistent")
  and fix them — a vague "looks good" wastes the screenshot.

## Rules

- `snapshot` (text) is the DEFAULT check — cheap. `screenshot` is for VISUAL judgment only and is
  budgeted (a few per session): never screenshot twice in a row without changing something.
- `open` first, always; navigate with `open {path:"/route"}`.
- The origin is fixed to the app's own preview — there is nothing else to browse.
- A dev-server error from `open` means the app CRASHES at runtime: read the error, fix, rebuild.
