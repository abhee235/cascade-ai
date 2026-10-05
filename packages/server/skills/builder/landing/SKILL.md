---
name: landing
description: Landing pages that read as 2026, not 2021 — the band order, the four variants (SaaS, launch, portfolio, waitlist), the modern hero/bento/pricing/FAQ vocabulary, and real copy rules.
whenToUse: Load BEFORE building any landing page, home page, marketing site, product page, hero section, pricing page, about page, portfolio, waitlist, or "coming soon" page.
---
# Landing pages — structure sells, and the structure is a stack of bands

Every band starts from a BLOCK pattern: use it as it is, or adapt it to THIS product — its structure, its
content, its visual anchor (keep the `data-block` stamp and token-only styling, so it still follows the
preset). A band that is a stock block with swapped copy is how a page ends up looking like every other one.

## The band order — the spine every variant bends

```
<NavBar>                                  <Logo> · 2–4 links · ONE primary Button
<Hero layout="collage">                   badge · TWO-TONE headline · subcopy · 2 actions · media
<Section compact><LogoStrip>              trust, close under the hero (a thin band is compact)
<Section tone="muted"><BentoGrid>          the "why" — MIXED tiles, not a row of clones
<Section><PricingTable>                    2–4 tiers, exactly ONE highlighted
<Section tone="wash"><Testimonial>         one strong quote (variant="feature") or three cards
<Section><FAQ>                             the objections that block a purchase
<CTASection>                               the closing ask
<Footer>                                   brand · 3 link columns · fineprint
```

The **two-tone headline** is the current idiom — put the second clause in muted — and the hero ALWAYS
carries real imagery (`media` below): a text-only hero fails the design lint, every time:

```tsx
<Hero
  headline={<>Ship your pipeline, <span className="text-muted-foreground">not your weekend.</span></>}
  media={<ArtImage kind="banner" seed="hero" />}   // or photo('workspace') — never omit, never an emoji
/>
```

All FOUR variants exist as working pages — `Skill {name: "landing", file: "reference/pages.md"}` is
their verbatim source. They differ in STRUCTURE, not just copy, so read the one whose shape matches the
ask before you compose bands from scratch.

## The four variants — same spine, different emphasis

| variant | preset that suits it | keep | drop | hero |
|---|---|---|---|---|
| **saas** | `aurora-glass`, `minimal-mono` | bento, pricing, FAQ, logos | — | `collage`, product shot |
| **launch** | `luxe-dark`, `playful` | bento, testimonial, CTA | pricing (one product) | `bleed`, big imagery |
| **portfolio** | `editorial` | work grid (`MediaCard`), about, contact | pricing, logos | `centered`, quiet |
| **waitlist** | any | ONE screen: hero + email form + proof | pricing, FAQ, long bands | `centered` |

A waitlist page that scrolls is a waitlist page nobody signs up to.

## Copy — the part models get wrong

- Headline ≤ ~8 words, a CLAIM not a category ("Ship your pipeline, not your weekend", never "Our Platform").
- Subcopy: ONE sentence naming who it is for and what changes.
- Features say the outcome ("Send it back any year — we fix it"), not the mechanism ("Repair API").
- Testimonials carry a real name AND role. "John D., CEO" reads as fake because it is.
- FAQ answers what BLOCKS a purchase: price, cancellation, data ownership, support. Never puffery.
- NEVER lorem ipsum, and never a button that does nothing — every CTA changes the view or opens a form.

## Imagery

Hero: one `photo()` / `photoFor()` / `<ArtImage kind="banner">`. Logo strip: TEXT wordmarks (credible with
zero assets). Any grid of distinct subjects: `<Photo web="…" seed={item.id}>` — never `photoFor()` in a
`.map()`, which repeats the same two pictures.

## Acceptance — check each before you call it done

- [ ] Bands present in order: NavBar → Hero → (LogoStrip) → BentoGrid or FeatureGrid → PricingTable (if
      priced) → Testimonial → FAQ → CTASection → Footer. **≥5** bands total on a full landing page.
- [ ] One rhythm: no padding or margins added between bands; every band carries an anchor (product
      visual, data, image) — none is a heading and a grey line.
- [ ] The brand: `<Logo name="…" />` (the name as a wordmark) in the NavBar and the Footer.
- [ ] Headline ≤ 8 words and two-tone; subcopy is ONE sentence.
- [ ] The hero carries REAL imagery — `<ArtImage>` or `photo()`/`photoFor()` — and any grid of distinct
      subjects uses `<Photo web="…" seed={item.id}>`. A page with zero imagery fails the design lint.
- [ ] Exactly ONE primary `<Button>` above the fold (everything else `variant="outline"`/`"ghost"`).
- [ ] Pricing: 2–4 tiers, exactly one `highlighted`, each with its own action.
- [ ] Zero lorem, zero placeholder names, zero dead buttons.
- [ ] `npm run build` green → `TemplateAudit` clean → `Browser {op:"open"}` → `Browser {op:"audit"}` clean
      (audit catches sections stuck invisible — a scroll-reveal that never fires leaves a blank page).

## Out of scope unless asked

Blog engines, CMS, i18n, analytics, cookie banners, real payment links.
