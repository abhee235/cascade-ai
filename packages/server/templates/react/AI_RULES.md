# Project rules (Vite + React + TypeScript + Tailwind)

You are editing a **Vite + React + TypeScript + Tailwind CSS v4** app. Follow these rules:

- The app entry is `src/main.tsx`; the root component is `src/App.tsx`. Put new components in `src/`.
- Use **functional components + hooks**. TypeScript everywhere (`.tsx`/`.ts`).
- Style with **Tailwind utility classes** only (Tailwind v4 is set up via `@import "tailwindcss"` in
  `src/index.css`). Do not add a `tailwind.config` unless asked; do not introduce other CSS frameworks.
- This project has a **design system**: theme tokens in `src/themes/` (active preset = the `@import`
  line in `src/index.css`), page block PATTERNS in `src/components/blocks/`, imagery via `src/lib/photos.ts`
  + `<ArtImage>`. Use token color utilities only (never raw colors); start pages from the block patterns
  and adapt them (keep their `data-block` stamps); one spacing rhythm (bands own their padding); a real
  `<Logo>` in the brand slots.
  The scaffold ships BLANK with `data-placeholder` markers (the NavBar brand and the scaffold panel in
  `App.tsx`) — replace every marked element with real app content and remove the attribute. The
  TemplateAudit tool enforces this: the app is not done while any placeholder (or legacy `src/demo/`
  residue) remains.
- Add dependencies with the package manager (npm) — don't hand-edit `package.json` versions.
- Keep the app runnable: `npm install` then `npm run build` must stay green. The Preview pane runs the dev server for you.
- Prefer small, composable components and clear names. Don't scaffold a backend unless asked.
