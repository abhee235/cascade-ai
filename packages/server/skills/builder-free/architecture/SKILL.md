---
name: architecture
description: Scaffolding a blank project and structuring it — the exact starter files (package.json, vite.config.ts with the preview's requirements, tsconfig, index.html, main.tsx), file layout, view switching, state placement, the per-feature checklist.
whenToUse: ALWAYS load before the FIRST file write of any session, and again before any new page, view, feature, or refactor. If unsure whether to load it: load it.
---
# Architecture — scaffold the proven stack, then keep it small and clear

The project starts EMPTY. Write the starter files below FIRST (verbatim unless PLAN.md's Stack says
otherwise), run `npm install`, then build the app. These versions are proven in this environment — do not
bump them to "latest".

## 1. package.json
```json
{
  "name": "<app-slug>", "private": true, "version": "0.0.0", "type": "module",
  "scripts": { "dev": "vite", "build": "tsc --noEmit && vite build", "preview": "vite preview" },
  "dependencies": { "react": "^19.2.8", "react-dom": "^19.2.8", "lucide-react": "^1.23.0" },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0", "@types/node": "^20.14.0", "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4", "@vitejs/plugin-react": "^4.3.1", "tailwindcss": "^4.0.0",
    "typescript": "^5.5.0", "vite": "^5.4.0"
  }
}
```
Add the two font packages from PLAN.md (`@fontsource-variable/<name>`) to dependencies. `dev` stays exactly
`vite`: the preview runs `npm run dev -- --host --port <port>`.

## 2. vite.config.ts — the preview needs these server settings
```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = process.cwd()
const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT ? Number(process.env.VITE_HMR_CLIENT_PORT) : undefined
// Visual editing: stamps each host JSX element with its file:line:col (dev only). Keep it.
const locStamp = ({ types: t }: any) => ({
  visitor: {
    JSXOpeningElement(path: any, state: any) {
      const loc = path.node.loc, name = path.node.name
      if (!loc || name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name)) return
      if (path.node.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-cascade-loc')) return
      let f = String(state.filename || '')
      if (f.startsWith(root)) f = f.slice(root.length).replace(/^[\\/]/, '')
      path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-cascade-loc'), t.stringLiteral(`${f.replace(/\\/g, '/')}:${loc.start.line}:${loc.start.column}`)))
    },
  },
})

export default defineConfig(({ command }) => ({
  plugins: [react({ babel: { plugins: command === 'serve' ? [locStamp] : [] } }), tailwindcss()],
  resolve: { alias: { '@': resolve(root, 'src') } },
  server: {
    host: true,
    // Cascade's own bookkeeping lives in the project; watching it would reload the page on every append.
    watch: { usePolling: true, interval: 120, ignored: ['**/.cascade/**', '**/PLAN.md', '**/DESIGN.md'] },
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : true,
  },
}))
```

## 3. tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext",
    "moduleResolution": "bundler", "jsx": "react-jsx", "strict": true, "noEmit": true, "skipLibCheck": true,
    "noUnusedLocals": true, "noUnusedParameters": true, "baseUrl": ".", "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"]
}
```

## 4. Entry files
- `index.html`: `<html lang="en">`, a real `<title>` (the app's name), `<div id="root">`, and
  `<script type="module" src="/src/main.tsx">`.
- `src/main.tsx`: import the font packages, then `./index.css`; `createRoot(…).render(<StrictMode><App /></StrictMode>)`.
- `src/index.css`: `@import "tailwindcss";` then `@import "./theme.css";` (the design skill's token file), and
  one base layer: `body { background: var(--background); color: var(--foreground); font-family: var(--font-body) }`.
- Then `npm install`, then `npm run build` — green before the first feature.

## 5. File layout
- `src/views/<View>.tsx` — one file per view in PLAN.md.
- `src/components/<Name>.tsx` — one concern each, every file under ~150 lines (Logo, SiteHeader, SiteFooter,
  ProductCard, …). Extract as you go: a file that outgrows the read window makes every later edit blind.
- `src/data/` — seed data. `src/lib/` — hooks and helpers. `src/types.ts` — every shared type, one owner.

## 6. Views without a router
Keep the current view in state and mirror it into the URL hash, so the browser Back button works:
```ts
export function useView<V extends string>(initial: V) {
  const read = () => ((location.hash.slice(1) as V) || initial)
  const [view, setView] = useState<V>(read)
  useEffect(() => { const on = () => setView(read()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on) }, [])
  return [view, (v: V) => { location.hash = v; window.scrollTo(0, 0) }] as const
}
```
Every view opens at the top (the `scrollTo` above). SiteHeader and SiteFooter render ONCE in `App.tsx`, around
the current view — never per view, so the chrome is identical everywhere.

## 7. State placement
- Shared state (the cart, the selected item, the user's list) lives in `App.tsx` or one hook in `src/lib/`;
  views receive props. Derive totals and counts — never store them twice.
- Persistence: `src/lib/storage.ts` with `load<T>(key, fallback)` / `save(key, value)` over localStorage, each in
  try/catch (storage can be unavailable). Load once on start, save on change.

## 8. Workflow per feature — tick it as you go
- [ ] The types it needs exist in `src/types.ts`.
- [ ] Its components exist, each one concern, each under ~150 lines.
- [ ] It is reachable from the UI (a link or button leads to it) and Back returns.
- [ ] Its state is placed per §7; nothing is computed in two places.
- [ ] `npm run build` is green before moving on.
