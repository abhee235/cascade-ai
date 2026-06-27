# Cascade — Progress Dashboard

> Single source of "where are we." Update this whenever a checkpoint lands.
> Legend: ✅ done · 🔨 in progress · ⬜ todo · 🚧 blocked.
> Bars are 20 cells: `█` done · `░` remaining.

---

## Overall

**Engine (the algorithm)** — `████████████████████` **100%** — Phases 0–13.3 complete & tagged.
**Builder (the product)** — `████░░░░░░░░░░░░░░░░` **~20%** — sandbox + shell + templates shipped; preview/code/etc. ahead.

---

## 1. Core engine — Phases 0–12  ✅  `████████████████████` 100%

All built, driven by the VS Code extension, each tagged `phase-0` … `phase-12`.

✅ 0 scaffold · ✅ 1 Ollama call · ✅ 2 stream + activity-first · ✅ 3 message model + system prompt ·
✅ 4 agentic loop · ✅ 5 execution pipeline · ✅ 6 concurrency · ✅ 7 permissions · ✅ 8 activity timeline ·
✅ 9 lazy MCP · ✅ 10 compaction + memory · ✅ 11 resilience + subagents · ✅ 12 server + web (browser chat)

---

## 2. Builder backend — Phase 13.x  `██████████████░░░░░░` ~70% of the *planned* 13.x

| | Checkpoint | Tag |
|---|---|---|
| ✅ | **13.1** server (WS) + minimal web over the same core | `phase-13.1` |
| ✅ | **13.2** projects/workspaces — dedicated session per project (ADR-021) | `phase-13.2` |
| ✅ | **refactor** extract app/builder protocol → `@cascade/app-protocol` (keep core pure) | `2ab4b4c` |
| ✅ | **13.3** Docker sandbox — generic `Sandbox` seam + per-project container (ADR-024) | `phase-13.3` |
| ✅ | **13.4** 3-pane builder shell (folded into M1) | `44009e5` |

**Verified:** 81 tests pass + 5 gated skips · 4 packages typecheck · sandbox proven end-to-end through the
real Ollama model (agent Bash runs in an Alpine container, host untouched).

---

## 3. Builder backend roadmap (the "make it real" work)  `████░░░░░░░░░░░░░░░░` ~20%

Each lands as a runnable, tested checkpoint. (Preview/Terminal need the 13.3 sandbox ✅.)

| | Item | Notes |
|---|---|---|
| ✅ | **Templates / scaffolding** | `ProjectManager.create` copies a Vite+React+Tailwind scaffold + `git init`; AI-rules via a generic core seam (ADR-025, `guide/phase-15.md`) |
| 🔨 | **File service** | read/list/write project files (for the Code pane) — **next** |
| ⬜ | **Live preview** | run dev server in the sandbox → proxy → iframe |
| ⬜ | **Integrated terminal** | xterm ↔ sandbox PTY over the protocol |
| ⬜ | **Git checkpoints / restore** | commit each change-set; versions list + restore (baseline commit already lands at create) |
| ⬜ | **Build-error auto-fix loop** | run checks in the sandbox; feed problems back |
| ⬜ | **Persistence** | durable chats/versions; replay history on reattach |
| ⬜ | **Deploy / integrations** | GitHub / Vercel / Supabase (gated, optional) |

---

## 4. Builder web frontend — milestones (`docs/PLAN-web-frontend.md`)  `███░░░░░░░░░░░░░░░░░` ~15%

| | Milestone | Notes |
|---|---|---|
| ✅ | **M1 Shell** | resizable 3-pane, zustand store, **design system** (dark/light toggle), **real shadcn/ui** (Radix), per-tool activity cards, StreamingOptimizer |
| 🔨 | **M2 Activity cards** | file-edit diffs, AddDependency, MCP, **permission card** |
| ⬜ | **M3 Preview** | iframe + toolbar (needs preview proxy) |
| ⬜ | **M4 Code** | FileTree + Monaco + diff (needs file service) |
| ⬜ | **M5 Console/Problems** | dev-server logs + problems + "Fix all" |
| ⬜ | **M6 Versions** | checkpoint list + diff + restore |
| ⬜ | **M7 Terminal** | xterm pane |
| ⬜ | **M8 Settings** | model/provider, tools/MCP, switches |
| ⬜ | **M9 Visual editing** | click-to-edit over the preview |
| ⬜ | **M10 Integrations/Deploy** | publish panels |
| ⬜ | **M11 Theming/polish** | custom themes, command palette, attachments, multi-chat |

---

## Minimum path to "usable as a builder"

Templates → File service + **M4 Code** (see files) → Live preview + **M3** (see it run) → **M2** permission/
edit cards → Git checkpoints + **M6** → Terminal + **M7**. After that: prompt → running app → edit → restore.
