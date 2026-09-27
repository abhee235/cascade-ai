# Cascade marketing site

The page at **appbuilder.sh**. One pre-built HTML file and its images — there is no framework, no
build step, and no compilation. `public/` is uploaded to Cloudflare Workers as static assets.

## Layout

```
site/
├── public/          ← THE ASSETS DIRECTORY. Everything in here is served publicly.
│   ├── index.html
│   └── assets/      images, logos, og-cover.png
├── og-card.html     source for the 1200x630 link-preview card
├── og-card.mjs      renders og-card.html -> public/assets/og-cover.png
├── wrangler.jsonc   Cloudflare config
└── package.json     pins wrangler; NOT part of the root workspace (that glob is packages/*)
```

The `public/` split is load-bearing, not tidiness. Everything under the assets directory is served at
`https://<host>/<path>`, so `node_modules/` and the manifests must be outside it. `.assetsignore` was
tried first and measured inert on wrangler 4.142.0 — with it listing `index.html` the deploy read 1983
files; with no ignore file at all, 1982. The one-file delta was the ignore file counting itself. It would
have published 1700 `node_modules` files to the edge. Do not reintroduce it as a safety net; it is not one.

**Never move `wrangler.jsonc`, `package.json` or `node_modules` into `public/`.**

## Cloudflare Builds settings

These live in the dashboard (Workers → cascade → Settings → Build) and cannot be set from this repo:

| Setting | Value |
| --- | --- |
| Root directory | `site` |
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy` |

Root directory is the one that matters. Left at `/`, the build installs the whole monorepo (1102 packages,
Electron included) and runs `npm run build --workspaces`, which fails at `@cascade/web` with a JS heap OOM
long before wrangler is reached. Scoped to `site`, the install is 37 packages and there is no build phase.

A healthy deploy log reads `added 37 packages` and `Read 21 files from the assets directory`. Anything in
the thousands means `node_modules` reached the assets directory.

## Working on it

```sh
cd site
npm ci
npm run dev       # local worker, closest to production
npm run check     # validate wrangler.jsonc without deploying
npm run deploy    # manual deploy (npx wrangler login first)
```

For pure HTML edits any static server works: `cd site/public && python -m http.server 4178`.

## Regenerating the link-preview card

`public/assets/og-cover.png` is committed, so this is only needed when the card's design or copy changes:

```sh
cd site && node og-card.mjs
```

It drives local Chrome/Edge via the monorepo's `playwright-core`, shoots at exactly 1200x630 and 1x
(scrapers reject oversized cards), and asserts Geist actually loaded rather than silently rendering the
card in a fallback face.

`og:image` must be an absolute URL per the OG spec, so it points at `https://appbuilder.sh/...` and will
404 in link previews until the domain is live. That resolves itself when the zone is pointed.

## Custom domain

The `routes` block in `wrangler.jsonc` is commented out. Uncomment it only after the zone is active in this
Cloudflare account (Add a site, then update the registrar's nameservers) — deploying a route for a zone
Cloudflare does not manage fails the entire deploy.
