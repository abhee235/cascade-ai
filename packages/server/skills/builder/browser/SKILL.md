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
- [ ] 3. For EACH key route (/, and every main view in PLAN.md): Browser {op:"open", path:"/route"} then snapshot
- [ ] 4. Browser {op:"audit"}                    — scrolls the WHOLE page: catches sections stuck invisible + console errors
- [ ] 5. Browser {op:"screenshot"}               — LOOK at it against the design checklist below
- [ ] 6. Fix what you saw; build; re-check the one thing you fixed
```

**No vision?** If op:"screenshot" errors with "no vision", skip step 5 — do NOT retry it. Steps 2–4 are
your eyes: the snapshot shows structure (an almost-empty tree = dead page), and audit's styles line
(stylesheet count, body font/background) plus its console errors replace the visual check. A console
stack names the broken file:line — that is better debugging data than any screenshot.

**Why audit is mandatory:** a scroll-reveal animation (IntersectionObserver / `whileInView`) that never
fires leaves whole sections — pricing, specs, CTA — permanently at `opacity: 0`. The code compiles, the
top-of-page screenshot looks fine, and real visitors see blank page. This exact bug shipped three builds
in a row before audit existed. `audit` FAILING means fix the reveal (or remove it — static content beats
invisible content) and re-run until it passes.

## Is it actually RUNNING? — check before you judge the look

A page can compile and still be dead. Before the design pass, confirm the app is alive on every main route:

- **Crash on open** — `open` returning a dev-server error means the app throws at runtime. Read the error,
  fix the cause, rebuild. Do not proceed to screenshots.
- **Blank / white page** — `snapshot` shows an almost-empty tree (no headings, no landmarks) or the
  screenshot is a blank canvas ⇒ the root didn't mount (a throwing component, a bad import, an empty
  route). That is a FAILURE even though the build passed.
- **Every PLAN.md view loads** — `open` each route. A route that 404s, blanks, or shows a stub is "not
  running" — list it explicitly; don't silently count it as done.
- **The main flow works** — do the one thing the app exists for (add a todo, add to cart, submit the form)
  and confirm the UI actually changes. A store where "Add to cart" does nothing is broken, not built.

## Write a Smoke Report — the output of this pass

End the smoke pass with a short, explicit report (this is what "I checked it" means):

```
SMOKE REPORT
- Running: <routes/flows that work>
- Not running: <routes that 404/blank/crash, flows that do nothing>  ← fix these FIRST
- Design-system gaps: <raw colors, unstyled boxes, block not used, inconsistent badges/cards>
- Imagery: <distinct-count per grid, any repeats/mismatches, any emoji-as-image>
- Verdict: SHIP / FIX (list the fixes)
```

Then FIX everything under "Not running" and "gaps", rebuild, and re-check what you fixed.

## Delegating the whole pass — the `smoketester` subagent

For a thorough, independent QA pass that keeps all the verbose snapshot/screenshot output OUT of your
build context, delegate: `Subagent {agent: "smoketester", prompt: "<what the app is + the routes/flows in
PLAN.md to exercise>"}`. It opens the app, walks every route and the main flow, and returns just the SMOKE
REPORT above — a punch-list you then fix. Prefer this on a larger app; run the inline smoke pass yourself
on a small one.

## Judging a screenshot — write a verdict for EVERY line

"Looks good / looks clean / looks great" is NOT a verdict — it is how you MISS things. For each item
below, write one concrete sentence naming what you actually see. If you can't point to specific pixels,
you didn't look. A screenshot with zero problems named is a screenshot you wasted.

- **Imagery — the #1 miss.** COUNT the distinct images. Do any repeat across different cards/items? Does
  each image actually MATCH its label (a "Ratatouille" card must not show a noodle bowl)? Repeated or
  mismatched photos are a bug even when each image loads fine. **The usual cause + fix:** the grid was
  mapped through `photoFor` (only ~2 photos per category → they MUST repeat). Switch each item to
  `<Photo web="<the item's real subject>" seed={item.id} kind="product" />` — a distinct, on-subject real
  photo per item that auto-falls back to `<ArtImage>`. Only reach for the `ImageSearch` tool if you want
  to hand-pick a specific hero shot. (No broken-icon ≠ good imagery.)
- **Consistency across states.** Put the variants side by side: do all the difficulty/status BADGES share
  one style (all solid, or all outline — not "Medium" solid-purple next to "Hard" white-outline)? Do all
  cards share one height, radius, shadow? Drift between siblings is the tell.
- **Designed bands** — real NavBar/hero/cards from the patterns, the name set as a wordmark, an even rhythm between bands — not unstyled text or hand-rolled boxes.
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
