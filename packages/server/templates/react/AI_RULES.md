# Project rules (Vite + React + TypeScript + Tailwind)

You are editing a **Vite + React + TypeScript + Tailwind CSS v4** app. Follow these rules:

- The app entry is `src/main.tsx`; the root component is `src/App.tsx`. Put new components in `src/`.
- Use **functional components + hooks**. TypeScript everywhere (`.tsx`/`.ts`).
- Style with **Tailwind utility classes** only (Tailwind v4 is set up via `@import "tailwindcss"` in
  `src/index.css`). Do not add a `tailwind.config` unless asked; do not introduce other CSS frameworks.
- This project has a **design system**: theme tokens in `src/themes/` (active preset = the `@import`
  line in `src/index.css`), page blocks in `src/components/blocks/`, imagery via `src/lib/photos.ts` +
  `<ArtImage>`. Use token color utilities only (never raw colors); assemble pages from blocks.
  `src/demo/` is the starter showcase — delete it (and rewrite `App.tsx`) when building the real app.
- Add dependencies with the package manager (npm) — don't hand-edit `package.json` versions.
- Keep the app runnable: `npm install` then `npm run dev` (Vite, port 5173). Don't break the build.
- Prefer small, composable components and clear names. Don't scaffold a backend unless asked.
