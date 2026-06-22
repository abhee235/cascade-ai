# Webview rendering (Streamdown)

How Cascade renders assistant markdown in the webview. Frontend-only — `@cascade/core` stays a clean
text/`ContentBlock` producer; rendering is a frontend concern (see `docs/FRONTEND.md`).

## Stack
- **[Streamdown](https://streamdown.ai/)** — streaming-safe markdown renderer (handles incomplete
  tokens mid-stream). Rendered via a single `Md` wrapper in `ui/App.tsx`; both the answer and the
  thinking go through it.
- **Plugins** (`mdPlugins` in `App.tsx`):
  - `@streamdown/mermaid` — diagrams.
  - `@streamdown/math` via `createMathPlugin({ singleDollarTextMath: true })` — KaTeX; inline `$…$`
    enabled (off by default to avoid clashing with currency).
  - `@streamdown/code` via `createCodePlugin({ themes: [t, t] })` — Shiki highlighting, **pure-JS
    engine (no WASM)**, so no CSP relaxation. Theme pinned to the detected VS Code theme.
- **Tailwind v4** builds `dist/webview.css` (`@source` scans Streamdown's classes); shadcn design
  tokens are mapped onto `--vscode-*` variables so the UI **adapts to the editor theme**.
- **KaTeX CSS** built separately (`ui/katex.css` → `dist/katex.css`) with **fonts inlined as data:
  URIs** (esbuild `dataurl` loader) — no font files to serve; CSP only needs `font-src data:`.

## Math delimiters
`remark-math` only parses `$…$` / `$$…$$`. Models also emit LaTeX-style `\[ … \]` / `\( … \)`, so
`normalizeMath()` in `App.tsx` converts those to `$$`/`$` **outside code spans/blocks**. All four
styles render. **Thinking often has no delimiters** (plain text like `e^x = 1 + x²/2!`) — that
intentionally stays as text; we don't guess-delimit prose.

## CSP (in `CascadeViewProvider`)
`script-src 'nonce-…'`; `style-src cspSource 'unsafe-inline'`; `img-src cspSource data: blob:`
(Mermaid SVG); `font-src cspSource data:` (inlined KaTeX fonts). No `'wasm-unsafe-eval'` needed
(Shiki JS engine).

## Theme
Adaptive to VS Code: `main.tsx` mirrors `vscode-dark`/`vscode-high-contrast` onto `<html>.dark`
(Shiki dual-theme + shadcn tokens key off `.dark`). `.cascade-md` in `styles.css` holds the
typography (headings, lists, inline code, KaTeX sizing/line-height guard).

## Notes / gotchas
- Bundle is large (~18 MB webview.js) — Mermaid + Shiki grammars are bundled for offline use. Lazy-load later if needed.
- KaTeX is sensitive to inherited `line-height`; `.cascade-md .katex* { line-height: normal }` guards it.
