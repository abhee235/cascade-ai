import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Runs inside the project's Docker container (see @cascade/server PreviewManager).
const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT ? Number(process.env.VITE_HMR_CLIENT_PORT) : undefined

// Cascade visual editing (M9): stamp every host (lowercase) JSX element with `data-cascade-loc="file:line:col"`
// so a click in the live preview can be mapped back to the exact JSX that produced it. Babel ships inside
// @vitejs/plugin-react, so this needs no extra dependency. Dev-only — the production build never stamps.
const root = process.cwd()
// biome-ignore lint: tiny inline Babel plugin (types injected by Babel)
const locStamp = ({ types: t }: any) => ({
  visitor: {
    // biome-ignore lint: Babel visitor node/state are untyped here
    JSXOpeningElement(path: any, state: any) {
      const loc = path.node.loc
      const name = path.node.name
      if (!loc || name.type !== 'JSXIdentifier') return
      if (!/^[a-z]/.test(name.name)) return // host elements only (skip React components — they may drop data-*)
      if (path.node.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-cascade-loc')) return
      let f = String(state.filename || '')
      if (f.startsWith(root)) f = f.slice(root.length).replace(/^[\\/]/, '')
      const value = `${f.replace(/\\/g, '/')}:${loc.start.line}:${loc.start.column}`
      path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-cascade-loc'), t.stringLiteral(value)))
    },
  },
})

export default defineConfig(({ command }) => ({
  plugins: [react({ babel: { plugins: command === 'serve' ? [locStamp] : [] } }), tailwindcss()],
  resolve: { alias: { '@': resolve(root, 'src') } }, // shadcn/ui convention (ADR-054)
  server: {
    host: true,
    // The project dir is a host bind-mount; native fs events don't cross it, so poll for edits.
    watch: { usePolling: true, interval: 120 },
    // The dev server is published on a random host port; tell the HMR client to use it (else it tries 5173).
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : true,
  },
}))
