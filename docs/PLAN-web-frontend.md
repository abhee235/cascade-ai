# Cascade Web Frontend — Build Plan & Component Catalog (prompt-to-app builder)

> **Scope:** the `@cascade/web` frontend only. Our backend (`@cascade/core` engine + `@cascade/server`)
> stays as-is — the web app is purely a **consumer of the existing `ActivityEvent` protocol** and a
> **sender of `InboundMessage`s**. No algorithm changes here.
>
> **Why this doc exists:** so the frontend has a *complete shopping list* of components/surfaces to build
> to look and feel like a modern hosted app builder — nothing left to "discover later." The catalog below
> was extracted from a real, shipped app builder so no feature is missed. We adopt its **design
> language and component set**, not its backend.
>
> **Status legend:** ✅ Have (already in `packages/web`) · 🔨 Build (on the path to production-grade) ·
> 🟡 Later (polish / optional) · ⛔ Skip (business-specific, not relevant to us).

---

## 1. Design system & foundations (set up once)

| Item | Decision |
|------|----------|
| Styling | **Tailwind v4** (`@import "tailwindcss"`) — already in use |
| Component kit | **shadcn/ui**, `new-york` style, base color **neutral**, CSS variables, **lucide** icons |
| Fonts | UI sans (system/Geist) + **Geist Mono** for code/terminal |
| Theme | CSS-variable tokens (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, …) + **dark mode default**, light optional; custom-theme support later |
| Layout | **Resizable 3-pane** split (`react-resizable-panels` or shadcn `resizable`); persisted sizes |
| Markdown | Streamdown (assistant answers) + a code-highlighter for fenced blocks |
| Animations | subtle (tw-animate-css equivalent): streaming pulse, card expand/collapse |
| Icons | lucide-react throughout |

**Build:** install shadcn + lucide; port `globals.css` token set; add resizable panel primitive; wire a
theme provider (dark default). 🔨

---

## 2. App shell & layout

| Component | Purpose | Status |
|-----------|---------|--------|
| `TitleBar` | top bar: app name, active project, connection dot, global actions (new project, settings) | 🔨 (we have a minimal header) |
| `AppLayout` | the 3-pane shell: left rail ∣ center (chat) ∣ right (builder), resizable | 🔨 |
| `Sidebar` (app rail) | collapsible left rail: project list + nav (chat / settings) | ✅ basic sidebar → 🔨 upgrade |
| `ConnectionIndicator` | WS connected/connecting/reconnecting state | ✅ Have |
| `ErrorBoundary` | catch render errors, show a recoverable fallback | 🔨 |
| `CommandPalette` (⌘K) | quick-switch projects / actions (shadcn `command`) | 🟡 Later |

---

## 3. Projects / workspace management

| Component | Purpose | Status |
|-----------|---------|--------|
| `ProjectSidebar` / list | list projects, active state, open/select | ✅ Have |
| `CreateProjectDialog` | name + **template picker** (see backend Phase 15) | 🔨 (inline create exists; upgrade to dialog + templates) |
| `ProjectItem` | row: name, icon, hover actions (rename/delete) | ✅ basic → 🔨 |
| `DeleteConfirmationDialog` | confirm destructive project delete | 🔨 |
| `RenameDialog` | rename a project | 🟡 |
| `EmptyState` | "select or create a project" | ✅ Have |
| `ImportProjectDialog` | import an existing folder/repo as a project | 🟡 Later |
| `TemplateCard` / template gallery | choose a starter (Vite+React+TS+Tailwind, etc.) | 🔨 |

---

## 4. Chat pane (center)

| Component | Purpose | Status |
|-----------|---------|--------|
| `ChatPanel` | container: header + messages list + input | ✅ basic |
| `ChatHeader` | project/chat title, model selector, actions | 🔨 |
| `MessagesList` | virtualized scroll of message + activity items | ✅ basic → 🔨 (virtualize) |
| `ChatMessage` (user/assistant) | bubble; assistant via Streamdown | ✅ Have |
| `ChatInput` | multiline composer, send/stop, ⌘↵ submit | ✅ Have |
| `ChatInput` rich (mentions/attachments) | @file mentions, image/file attach, drag-drop | 🟡 Later |
| `AttachmentsList` / `DragDropOverlay` | show + drop attachments | 🟡 Later |
| `ModelPicker` | choose Ollama model per chat | 🔨 |
| `ChatModeSelector` | mode (build / ask / plan) selector | 🟡 Later |
| `StreamingLoadingAnimation` | "thinking/working" animation while busy | ✅ basic → 🔨 polish |
| `QueuedMessagesList` | messages queued while busy | 🟡 |
| `ContextLimitBanner` / `TokenBar` | context usage indicator | 🟡 Later |
| `NewChatButton` / `ChatList` | multiple chats per project (history) | 🟡 Later |
| `ScrollToBottom` | jump to latest | 🔨 |

---

## 5. Agent activity / action cards — **the heart of the builder chat**

These are the per-action cards rendered inline in the chat as the agent works. In Cascade each maps to an
`ActivityEvent` (`toolStart`/`toolResult`/`fileEdit*`/`status`/…). This is the **single most important set**
for the builder feel — a live, legible timeline of what the agent is doing. Build a card per action type:

| Card | Shows | Status |
|------|-------|--------|
| `WriteFileCard` | "Writing `src/App.tsx`" + streaming + collapsible **diff** | 🔨 |
| `EditFileCard` | "Editing `…`" + before/after **diff** | 🔨 |
| `RenameFileCard` / `DeleteFileCard` | file rename/delete action | 🔨 |
| `ReadFileCard` | "Reading `…`" (compact) | 🔨 |
| `ListFilesCard` | directory listing result | 🔨 |
| `GrepCard` / `CodeSearchCard` + result | search query + matches | 🔨 |
| `RunCommandCard` (Bash) | command + **live streaming stdout** + exit status | ✅ basic (tool card) → 🔨 streaming |
| `AddDependencyCard` | "Adding `react-hot-toast`" + install status | 🔨 |
| `ChangeSetCard` | groups a turn's file edits into one reviewable unit + summary | 🔨 |
| `ThinkingCard` | collapsible reasoning (we already collapse thinking) | ✅ Have |
| `StatusCard` | transient "Planning…/Generating…" status line | ✅ Have |
| `ProblemSummaryCard` | build/type errors found + "Fix all errors" button | 🔨 |
| `McpToolCallCard` / `McpToolResultCard` | MCP tool invocation + result | 🔨 |
| `WebSearchCard` / `WebFetchCard` + results | web tool actions | 🟡 Later |
| `MemoryCard` | "💾 Remembered …" marker | ✅ Have |
| `CompactionCard` | "🗜 Context compacted" marker | ✅ Have |
| `RecoveringCard` | "reconnecting/compacting & retrying…" | ✅ Have |
| `ExecuteSqlCard` | DB query + result (if/when DB integration) | 🟡 Later |
| `TodoListCard` | agent's plan/todo checklist | 🟡 Later |
| `PermissionCard` | allow/allow-always/deny a gated action (blocks the turn) | 🔨 (protocol has `permission`) |
| `CopyButton` / `CodeHighlight` | copy code, syntax-highlight fenced blocks | 🔨 |
| `MarkdownRenderer` | rich assistant markdown (Streamdown) | ✅ Have |

> Implementation note: drive these from a single `ActivityEvent → card` switch (like our current
> `items.map`), one component per `type`. The `fileEdit*` / `changeSet` events are added on the backend
> side; the frontend just renders the cards.

---

## 6. Builder right pane — tabbed

The right pane is a **tabbed surface** (`PreviewPanel`-style): **Preview ∣ Code ∣ Console ∣ Problems ∣
Versions** (+ Configure/Publish later). Tabs share a toolbar.

### 6a. Preview tab (the signature feature)
| Component | Purpose | Status |
|-----------|---------|--------|
| `PreviewPanel` | tab container + toolbar | 🔨 |
| `PreviewIframe` | iframe showing the running app (via server preview proxy) | 🔨 |
| `PreviewToolbar` | URL/route box, reload, open-in-browser, device-size toggle | 🔨 |
| `PreviewLoadingScreen` | "installing deps / starting dev server…" states | 🔨 |
| `PreviewErrorOverlay` | runtime error captured from the iframe | 🟡 Later |

### 6b. Code tab (file tree + editor)
| Component | Purpose | Status |
|-----------|---------|--------|
| `FileTree` | the project's file structure, expand/collapse, select | 🔨 |
| `CodeView` | tab layout: tree ∣ editor | 🔨 |
| `FileEditor` (**Monaco**) | view/edit a file; save (gated) | 🔨 |
| `FileDiffEditor` | side-by-side / inline diff for a change | 🔨 |
| `FileTabs` / breadcrumb | open-file tabs + path breadcrumb | 🟡 |

### 6c. Console tab
| Component | Purpose | Status |
|-----------|---------|--------|
| `Console` | app/dev-server log stream | 🔨 |
| `ConsoleEntry` | one log line (level, source, time) | 🔨 |
| `ConsoleFilters` | filter by level/search | 🟡 |

### 6d. Problems tab
| `Problems` | list of tsc/build problems (file:line, message), click-to-open, "Fix all" | 🔨 |

### 6e. Terminal (pane or tab)
| Component | Purpose | Status |
|-----------|---------|--------|
| `TerminalPanel` (**xterm.js**) | interactive terminal attached to the sandbox | 🔨 |
| terminal toolbar | clear, new shell, copy | 🟡 |

---

## 7. Versions / checkpoints

| Component | Purpose | Status |
|-----------|---------|--------|
| `VersionPane` / list | per-project checkpoints (git commits) with summaries | 🔨 |
| `VersionDiffView` | diff between versions / vs current | 🔨 |
| `RestoreButton` + confirm | restore to a checkpoint (truncates chat to match) | 🔨 |
| `HistoryNavigation` | step back/forward through versions | 🟡 |
| `UncommittedFilesBanner` | unsaved/uncommitted changes indicator | 🟡 |

---

## 8. Visual editing (click an element, edit it)

| Component | Purpose | Status |
|-----------|---------|--------|
| `VisualEditingToolbar` | toggle select/inspect mode over the preview | 🟡 Later |
| `SelectedComponentDisplay` | show the picked element + its source location | 🟡 Later |
| `StylePopover` / `ToolbarColorPicker` | quick style tweaks (color, spacing) → emit an edit | 🟡 Later |
| `SelectionComment` / `CommentCard` | leave a comment/instruction pinned to an element → prompt | 🟡 Later |
| `VisualEditingChangesDialog` | review visual changes before applying | 🟡 Later |

> High-impact but advanced; defer until preview + edit cards are solid.

---

## 9. Settings & model/provider config

| Component | Purpose | Status |
|-----------|---------|--------|
| `SettingsPage` / `SettingsList` | settings shell | 🔨 |
| `ModelsSection` / `ModelPicker` | list/select Ollama models, pull a model | 🔨 |
| `ProviderSettings` | base URL / endpoint config (Ollama host) | 🔨 |
| `ApiKeyConfiguration` | (only if non-Ollama providers added) | 🟡 |
| `AgentToolsSettings` / `ToolsMcpSettings` | enable/disable tools, manage MCP servers | 🔨 |
| `McpToolsPicker` | per-chat MCP tool selection | 🟡 |
| Behavior switches | auto-approve, auto-fix problems, context-compaction, keep-previews-running, etc. | 🟡 (port as needed) |
| `ThemeDialog` / `EditThemeDialog` | custom themes | 🟡 Later |
| `LanguageSelector` | i18n | ⛔ (skip for now) |

---

## 10. Integrations / publish (deploy)

| Component | Purpose | Status |
|-----------|---------|--------|
| `PublishPanel` | publish/deploy entry point | 🟡 Later |
| `GitHubConnector` / `GithubBranchManager` | push project to GitHub | 🟡 Later |
| `VercelConnector` | deploy → live URL | 🟡 Later |
| `SupabaseConnector` / `NeonConnector` | provision a backend/DB | 🟡 Later |
| `DatabaseSection` / `DatabaseEnvVars` | DB config + env vars | 🟡 Later |
| `SecurityPanel` / `ConfigurePanel` | per-project config | 🟡 Later |

---

## 11. shadcn/ui primitive set (build/import these)

`button · input · textarea · label · select · checkbox · switch · radio-group · toggle / toggle-group ·
dialog · alert-dialog · sheet · popover · tooltip · dropdown-menu · context-menu · command · tabs ·
accordion · card · badge · alert · separator · scroll-area · skeleton · sidebar · resizable · avatar ·
color-picker · number-input · loading-bar`

All `new-york` / neutral / lucide. 🔨 (import the ones each milestone needs.)

---

## 12. Build milestones (order)

**Minimum path to "looks like a real builder":** M1 → M2 → M3 → M4 → M6.

| Milestone | Delivers | Catalog sections |
|-----------|----------|------------------|
| **M1 — Shell** | shadcn + theme + fonts + resizable 3-pane shell + title bar + upgraded sidebar | 1, 2, 3 |
| **M2 — Chat parity** | full chat pane + the **activity/action card set** (§5) incl. streaming file-edit + diff cards, permission card, Bash streaming | 4, 5 |
| **M3 — Preview** | Preview tab: iframe + toolbar + loading/error states (consumes server preview proxy) | 6a |
| **M4 — Code** | Code tab: FileTree + Monaco FileEditor + FileDiffEditor | 6b |
| **M5 — Console/Problems** | dev-server console + problems list + "Fix all errors" | 6c, 6d |
| **M6 — Versions** | checkpoint list + diff + restore | 7 |
| **M7 — Terminal** | xterm terminal attached to sandbox | 6e |
| **M8 — Settings** | settings shell, model/provider, tools/MCP, behavior switches | 9 |
| **M9 — Visual editing** | click-to-edit over the preview | 8 |
| **M10 — Integrations/Deploy** | publish to GitHub/Vercel, DB connectors | 10 |
| **M11 — Theming/polish** | custom themes, command palette, attachments, multi-chat history | 1, 4, 9 |

---

## 13. Explicitly skipped (business-specific, not relevant to Cascade)

Vendor-specific surfaces we **do not** build: paid plans, trials, prices and quotas, telemetry banners,
mobile wrappers, OS-notification guides, community-code consent,
Azure/Vertex provider specifics, media library, image-generation, app collections/hub/showcase. (Revisit
individually only if a real need appears.)

---

## 14. Guardrails

- The web app **only** consumes `ActivityEvent` and sends `InboundMessage`. Any new card needs a
  serializable event from the backend — never reach into core/server internals from the UI.
- Editing a file in Monaco must go through a **gated save** (a tool / explicit permitted save inbound),
  never a silent host write.
- Keep components small and composed from the shadcn set; one card component per `ActivityEvent` type.
