# design-sync notes — @cascade/web

Repo-specific gotchas for future syncs of this design system. Read before re-syncing.

## Shape & build
- **@cascade/web is a Vite APP, not a published component library.** There is no `dist/` component
  entry and no shipped `.d.ts` tree. We sync only the 14 shadcn/ui primitives in `src/components/ui/*`
  (new-york style, Tailwind v4). App-composition components (`builder/`, `chat/`, `layout/`) are out of
  scope — they depend on zustand/Monaco/xterm.
- **Synth entry:** `cfg.entry = .design-sync/ds-entry.ts` re-exports only the 14 `ui/` files. Do NOT
  let the converter auto-synthesize from all of `src/` (it would pull in app components). `export *`
  carries every sub-part (DialogContent, SelectItem, …) into `window.CascadeWebUI` for composition.
- **Dependencies are hoisted to the monorepo root** `<repo>/node_modules`
  (the web package's own `node_modules` is empty). Pass that as `--node-modules`.
- **Component contracts (`cfg.dtsPropsFor`) are hand-written.** The primaries use inline anonymous prop
  types (`React.ComponentProps<…> & VariantProps<…>`), which the extractor can't resolve, so it fell
  back to `{ [key: string]: unknown }`. The hand-written bodies in config are the real, design-relevant
  contracts. Keep them in sync if the components' props change.

## CSS (`cfg.buildCmd = node .design-sync/build-css.mjs`)
- The app's built `dist/assets/*.css` is **stale** (old HSL tokens, pre-OKLCH). Never reuse it.
- `build-css.mjs` compiles `src/index.css` fresh with the hoisted `@tailwindcss/cli` into
  `.design-sync/.cache/ds-styles.css` (= `cfg.cssEntry`). It:
  - scans `.design-sync/previews/**` via an explicit `@source` (Tailwind auto-detection skips the
    hidden `.design-sync/` dir, so preview-only utility classes would otherwise be missing);
  - hoists the Geist Google-Fonts `@import url(...)` to the top (Tailwind emits it after rules, where
    browsers ignore it → font wouldn't load).
- Tokens live INSIDE `_ds_bundle.css` (the compiled Tailwind output), not a separate `tokens/` dir.
  Geist/Geist Mono load via a remote `@import` (`[FONT_REMOTE]`, expected — no local fonts to ship).

## Preview authoring
- Previews import from `@cascade/web` (redirected to `window.CascadeWebUI`); `lucide-react` icons
  bundle normally. Icons verified present in v1.21: Search, Plus, Check, ChevronRight/Down, Settings,
  X, Trash2, Loader2, File, Folder, Play, Send.
- **Global provider = `TooltipProvider`** (`cfg.provider`), layout-neutral, so Tooltip floor cards
  don't crash.
- **Sidebar** must be wrapped in `SidebarProvider` in its own preview; use `collapsible="none"` and a
  fixed-height wrapper so it renders statically (the default offcanvas variant + mobile detection
  otherwise hide it). Keep the card viewport ≥ 780px wide (below 768 it switches to the mobile Sheet).
- Overlays use `cfg.overrides.<Name> = {cardMode:"single", viewport, primaryStory}` — Dialog, Sheet,
  Select, DropdownMenu, Tooltip. Modal overlays (Dialog/Sheet) render via CSS transforms; Popper
  overlays (Select/DropdownMenu/Tooltip) need a real trigger ref (see below).

## Known DS quirks (surfaced during authoring)
- **Button has no `forwardRef`** (plain function component). Under React 18, a Radix `asChild` trigger
  wrapping `<Button>` (e.g. `<DropdownMenuTrigger asChild><Button>`) drops the ref, so the popper never
  anchors and the menu/tooltip renders OFF-SCREEN. DropdownMenu/Tooltip previews therefore style the
  bare Radix trigger element directly instead of `asChild` + Button. Select is unaffected (uses
  `<SelectTrigger>` directly). This is a real DS limitation worth documenting to the design agent.
- **No `tailwindcss-animate` / `tw-animate-css`.** `src/index.css` never imports it, yet the overlay
  components reference `animate-in`/`fade-in`/`zoom-in`/`slide-in-from-*`/`data-[state=*]` classes.
  Those classes are therefore inert (no CSS) — overlays snap in/out with no entrance animation. This
  matches the app's actual behavior, and it keeps static captures visible (adding the plugin could
  freeze captures at an opacity-0 keyframe). Left as-is deliberately.

## Known render warns
- Separator's floor card was `[RENDER_BLANK]` (a hairline is naturally <5KB) — resolved by authoring
  `Separator.tsx`. Not a real warn once authored.

## Re-sync risks (what to watch next time)
- **Hand-written `cfg.dtsPropsFor`** — the 14 contracts are maintained by hand (inline prop types can't
  be auto-extracted). If a component's props change in `src/`, its `.d.ts` here goes stale silently.
  Re-read the changed component's signature and update the config body.
- **Upstream-code-tied workarounds** — two previews (DropdownMenu, Tooltip) style the bare Radix
  trigger *because* Button lacks `forwardRef`, and the conventions "gotcha" documents the same. If the
  app adds `forwardRef` to Button (or upgrades to React 19 where ref is a prop), revisit both — the
  `asChild`+Button pattern would then work and the workaround/gotcha become outdated.
- **No animation plugin** — if the app later imports `tailwindcss-animate`/`tw-animate-css`, the overlay
  entrance animations become real; re-verify static captures don't freeze at an opacity-0 keyframe
  (may need `prefers-reduced-motion` handling in the capture).
- **Network-fetched Geist** — fonts load via a remote Google-Fonts `@import`; an offline build renders
  in the fallback stack. Not shipped locally by design.
- **Toolchain assumptions** — build uses the hoisted `@tailwindcss/cli` at `../../node_modules` and
  Playwright 1.61.1 + chromium-headless-shell installed into `.ds-sync/` (gitignored). A fresh clone
  must re-run `npm i --prefix .ds-sync esbuild ts-morph @types/react playwright` and
  `node .ds-sync/node_modules/playwright/cli.js install chromium`.
- **Token safelist auto-syncs** — `build-css.mjs` derives the safelisted token utilities from
  `src/index.css`'s `@theme` `--color-*` names. Renamed/added tokens flow through automatically; if the
  `@theme` block's structure changes, re-check the `--color-([a-z0-9-]+)` regex still matches.
- **Only the 14 `ui/` primitives are synced** — new files added to `src/components/ui/` are NOT picked
  up automatically (the entry + `componentSrcMap` enumerate them explicitly). Add new primitives to
  both `ds-entry.ts` and `componentSrcMap` (and author a preview) on the next sync.
