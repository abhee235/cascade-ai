// Builds two bundles:
//   dist/extension.js — the VS Code extension host (CommonJS, Node). Bundles @cascade/core in-process.
//   dist/webview.js   — the React webview UI (IIFE, browser).
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

// Build stamp baked into BOTH bundles. The host sends its stamp to the webview on connect; the webview
// compares with its own and shows a "stale host — restart the debug session" banner on mismatch. This
// exists because a webview-panel reload loads fresh webview.js while the extension host keeps running the
// OLD extension.js from memory — an invisible split that cost a debugging session to identify.
const buildStamp = JSON.stringify(new Date().toISOString())

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // vscode: provided by the VS Code runtime. playwright-core: lazy-imported by the Browser tool and
  // full of dynamic requires — must stay a real node_modules resolve, never bundled.
  external: ['vscode', 'playwright-core'],
  define: { __CASCADE_BUILD__: buildStamp },
  sourcemap: true,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const katexCssOptions = {
  // KaTeX CSS with fonts inlined as data: URIs → dist/katex.css. No font files to serve.
  entryPoints: ['ui/katex.css'],
  outfile: 'dist/katex.css',
  bundle: true,
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['ui/main.tsx'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  define: { __CASCADE_BUILD__: buildStamp },
  sourcemap: true,
  logLevel: 'info',
}

if (watch) {
  const a = await esbuild.context(hostOptions)
  const b = await esbuild.context(webviewOptions)
  const c = await esbuild.context(katexCssOptions)
  await Promise.all([a.watch(), b.watch(), c.watch()])
  console.log('Cascade: watching for changes…')
} else {
  await Promise.all([
    esbuild.build(hostOptions),
    esbuild.build(webviewOptions),
    esbuild.build(katexCssOptions),
  ])
  console.log('Cascade: build complete → dist/')
}
