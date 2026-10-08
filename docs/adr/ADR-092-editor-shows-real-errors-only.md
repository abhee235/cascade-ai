# ADR-092 — The Code pane underlines real mistakes, not imports it cannot see

**Status:** accepted 2026-10-09 (user-approved). **Amends** the Code pane (Monaco, `packages/web/src/lib/monaco.ts`).

## Context — seen 2026-10-09 while taking README screenshots

Every TypeScript file in the Code pane was covered in red squiggles, even in Velocarta, whose `npm run build`
is green. `monaco.ts` configured no TypeScript options, so the editor ran Monaco's defaults: JSX off (every
`<Hero …>` line an error), no `@/` path alias, and no access to the project's `node_modules`, so every import
was "cannot find module". A user opening the editor would conclude their project is broken.

## Decision

1. **Compiler options match the templates:** `jsx: react-jsx`, target/module ESNext, bundler-style module
   resolution, `@/*` → `src/*`, `allowJs`, `esModuleInterop`, `isolatedModules`. Same for JavaScript.
2. **Semantic validation off, syntax validation on.** In the browser the editor cannot load the project's
   dependency types, so its type errors would still be guesses, and wrong ones. A missing bracket or a
   broken JSX tag is still underlined. Type errors are reported where they are true: `npm run build` (the
   agent's declared check) and TemplateAudit.

## Consequences

- The editor shows a project's code the way it is: clean when it builds, underlined where the syntax is broken.
- Lost: in-editor type errors. They were never reliable here; a later ADR can feed the project's real types
  (`node_modules/**/*.d.ts` via `addExtraLib`) if in-editor type checking is wanted.
