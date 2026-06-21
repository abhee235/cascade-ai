// Builds two bundles:
//   dist/extension.js — the VS Code extension host (CommonJS, Node). Bundles @cascade/core in-process.
//   dist/webview.js   — the React webview UI (IIFE, browser).
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'], // provided by the VS Code runtime
  sourcemap: true,
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
  sourcemap: true,
  logLevel: 'info',
}

if (watch) {
  const a = await esbuild.context(hostOptions)
  const b = await esbuild.context(webviewOptions)
  await Promise.all([a.watch(), b.watch()])
  console.log('Cascade: watching for changes…')
} else {
  await Promise.all([esbuild.build(hostOptions), esbuild.build(webviewOptions)])
  console.log('Cascade: build complete → dist/')
}
