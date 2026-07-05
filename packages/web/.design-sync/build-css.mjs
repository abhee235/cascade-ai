// design-sync CSS build step (cfg.buildCmd).
//
// @cascade/web is a Vite APP, not a published component library: its styling is
// Tailwind v4 CSS-first (src/index.css `@import 'tailwindcss'` + the OKLCH
// shadcn-neutral token layer). There is no shipped stylesheet, and the app's
// dist/ CSS is stale. So we compile src/index.css fresh with the repo's own
// hoisted @tailwindcss/cli.
//
// We compile a tiny wrapper entry that @imports src/index.css and adds explicit
// @source globs, because:
//   - Tailwind auto-detection skips hidden dirs, so the authored preview cards
//     under .design-sync/previews/ would be invisible — any utility class used
//     there but not already in the app would be missing from the CSS. Scanning
//     the previews dir makes preview authoring unconstrained.
//   - We also scan src/ so the components' own utilities are always included.
//
// One fix afterward: the Geist Google-Fonts `@import url(...)` sits after
// `@import 'tailwindcss'`, so Tailwind places it after real rules — where
// browsers ignore it (font never loads). We hoist every `@import url(...)` back
// to the top so Geist actually loads through the styles.css -> _ds_bundle.css
// closure.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const cacheDir = resolve(web, '.design-sync/.cache');
const previewsDir = resolve(web, '.design-sync/previews');
const cli = resolve(web, '../../node_modules/@tailwindcss/cli/dist/index.mjs');
const entry = resolve(cacheDir, 'tw-entry.css');
const out = resolve(cacheDir, 'ds-styles.css');

mkdirSync(cacheDir, { recursive: true });
mkdirSync(previewsDir, { recursive: true });

// Safelist the full semantic-token vocabulary. The design agent styles with token
// utilities (bg-card, text-card-foreground, ring-ring, bg-chart-1…) that no scanned
// source necessarily uses, so without this they'd be absent from the shipped CSS and
// its designs would render unstyled. We derive the token names from index.css's
// @theme block so the safelist stays in sync automatically.
const indexCss = readFileSync(resolve(web, 'src/index.css'), 'utf8');
const tokens = [...new Set([...indexCss.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]))];
const safelist = tokens.length
  ? `@source inline("{bg,text,border,ring}-{${tokens.join(',')}}");\n`
    + `@source inline("{rounded-{sm,md,lg,xl},font-sans,font-mono}");\n`
  : '';

// Wrapper entry: real token/utility source + explicit content globs + token safelist.
writeFileSync(entry, [
  `@import "${resolve(web, 'src/index.css').split('\\').join('/')}";`,
  `@source "${resolve(web, 'src').split('\\').join('/')}/**/*.{ts,tsx}";`,
  `@source "${previewsDir.split('\\').join('/')}/**/*.tsx";`,
  safelist,
  '',
].join('\n'));

execFileSync(process.execPath, [cli, '-i', entry, '-o', out], { stdio: 'inherit' });

// Hoist any `@import url(...)` (remote fonts) above all other rules so they stay valid.
let css = readFileSync(out, 'utf8');
const imports = [...css.matchAll(/@import\s+url\([^;]*\);/g)].map((m) => m[0]);
if (imports.length) {
  css = css.replace(/@import\s+url\([^;]*\);/g, '');
  css = imports.join('\n') + '\n' + css.replace(/^\s+/, '');
  writeFileSync(out, css);
  console.error(`  build-css: hoisted ${imports.length} remote @import(s) to top of ${out}`);
}
