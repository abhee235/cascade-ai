# ADR-028 — Tool display hints & file-edit diff cards (M2)

## Context

Watching the agent build should feel legible. The biggest gap: tool cards dumped truncated output (and file
content) into the chat. We need richer, cleaner per-action cards without (a) coupling the headless engine to
UI/app concepts or (b) overloading the model-facing `tool_result` content.

**Where does a diff go?** Researched the hosted app builders: one has a per-turn "Diff" *view*; one opens
*temporary diff panes*; one shows a **compact file card** in chat (`data.ts · +145/−1`) and the code on the
**right in the editor** — none dump a red/green diff into the chat bubble. So: **compact card in chat, diff
in the editor pane.** The full inline diff belongs in the **VS Code extension**, which is where
editor-integrated agents show it.

## Decision

**Tools may attach a generic `display` hint to their result; the engine passes it through untouched; the
frontend interprets it.** The first hint is `fileEdit` (a unified diff).

- `ToolResult.display?: ToolDisplay` where `ToolDisplay = { kind: 'fileEdit'; path; op: 'create'|'edit'|
  'overwrite'; diff }`. It rides on the `tool_result` `ContentBlock` and the `toolResult` `ActivityEvent`.
  The engine **never interprets it** (the model still only sees `content`); it's a rendering annotation for
  whatever UI is attached — same spirit as `ModelProvider`/`Sandbox` seams.
- A tiny dependency-free **`lineDiff`** (LCS, with a large-file guard) lives in `core/src/utils/diff.ts`.
  `Edit` diffs before→after; `Write` reads the previous content (if any) and reports `create` vs `overwrite`.
**Rendering — per frontend (same `display` hint over the same protocol):**
- **Web (builder):** the chat shows a **compact, clickable** file-edit card (`Edited · App.tsx · +1 −1`) —
  *no inline diff*. Clicking opens the file in the **Code pane**, where a **Monaco `DiffEditor`** compares the
  file at the last git commit (`git show HEAD:path`, server `readDiff`) vs now (a `Code`/`Diff` toggle). Other
  tool cards (Read/Grep/Bash) are compact too: a one-line header with any output **collapsed behind a chevron**
  — no code dumped in the chat.
- **VS Code extension:** an **inline** red/green diff in the panel (editor-agent style), via a `DiffBlock` using
  VS Code theme colors. The extension already receives `display` over the core protocol — no extra wiring.

## Consequences

- **Clean chat, diff where it belongs.** The chat stays a legible activity timeline; the actual diff lives in
  the editor pane (web) / panel (extension) — as the hosted builders do. End-to-end verified in the web
  (agent edit → compact card → Monaco diff vs HEAD with char-level highlights).
- **Generic & extensible.** `display` is a passthrough — new hint kinds (e.g. `addDependency`, `runCommand`,
  `webSearch`) slot in by adding a `kind` + a card, no engine changes. `diff.ts` is reused by the version-diff
  (checkpoints) and the extension's inline diff.
- **Core stays pure.** No app/UI concept entered the agent loop — only a generic optional annotation on a
  tool result, which the model ignores.
- **Not yet:** a per-turn `changeSet` grouping of multiple edits, live streaming of a write in progress, and
  refreshing the open diff automatically after a new edit are follow-ups.

## Prior art

Two shapes are common: scraping custom write/edit tags out of the model's text and rendering them as file
cards with a diff editor, or one bespoke component per tool. Cascade keeps the **structured tool-call**
boundary (no tag scraping) and adds the diff as a generic result annotation, so the same mechanism serves any
tool.
