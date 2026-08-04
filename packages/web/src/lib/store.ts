// store.ts — the web app's single source of UI state (zustand).
// It owns connection + projects + transcript + shell state, the WireEvent handler, and the actions the
// UI calls. The WebSocket transport is injected once (setSend) by App. Settings/permissions/MCP are
// session/wrapper concerns and deliberately NOT kept here — only pure UI state lives in the store.

import { create } from 'zustand'
import type { WireEvent, WireMessage } from './wsClient'
import { extractMessage, type BottomTab, type Item, type Page, type PreviewDevice, type PreviewState, type Recovering, type RightTab, type RuntimeError, type Streaming } from './types'
import { StreamingOptimizer } from './streamingOptimizer'
import { applyAccent, applyTheme, getInitialAccent, getInitialTheme, type Theme } from './theme'
import type { ChatMeta, EnabledModelInfo, FileNode, McpServerInfo, ModelLimits, Problem, ProjectInfo, TemplateInfo, Version } from '@cascade/app-protocol'

// ADR-068: events that mutate the active-chat transcript/streaming. Gated to the viewed project so a
// background turn (another project) can't bleed into this one. Everything else (projects, files, preview,
// turnActivity, chatHistory, …) is view-agnostic and always applied.
const TURN_EVENTS = new Set(['step', 'status', 'recovering', 'thinking_delta', 'text_delta', 'toolStart', 'toolProgress', 'toolResult', 'message', 'memory', 'question', 'compacted', 'context', 'turnDone', 'error'])

// Label for the `compacted` event's layer kind (ADR-039). Mirrors core's compactionKindLabel; inlined so the
// browser bundle doesn't pull in the node-side @cascade/core runtime just for a string.
function compactedLabel(kind: string): string {
  switch (kind) {
    case 'collapsed': return 'collapsed superseded reads/searches'
    case 'masked': return 'masked large old tool output'
    case 'microcompacted': return 'cleared old tool results'
    case 'snipped': return 'snipped large tool inputs'
    case 'summarized': return 'summarized older turns'
    default: return 'compacted context'
  }
}

interface UiState {
  // routing (lightweight in-store router)
  page: Page
  pendingPrompt: string | null // a Home prompt waiting for its project to be created
  pendingSlug: string | null // a /project/<slug> URL awaiting the projects list to resolve it
  slugNotFound: string | null // a /project/<slug> URL that failed to resolve (deleted/mistyped) → not-found view
  // connection + projects
  connected: boolean
  serverInfo: { sandbox: boolean; model: string; provider?: string; providers?: { id: string; configured: boolean }[] } | null // server greeting: Docker, active provider/model, provider menu (ADR-067)
  models: Record<string, string[]> // ADR-067: cached model lists per provider (filled by `models` events, for the picker)
  modelInfo: Record<string, { capabilities: string[]; contextWindow?: number; limits?: ModelLimits }> // ADR-067: per "provider/model" capabilities+context+slider limits (manager)
  modelManagerOpen: boolean // ADR-067: the model-management dialog is open
  enabledModels: EnabledModelInfo[] // ADR-067: the CURATED models shown in the picker (with per-model params)
  mcpServers: McpServerInfo[] // ADR-071: configured MCP servers + live connection status (the MCP panel)
  projects: ProjectInfo[]
  templates: TemplateInfo[]
  activeId: string | null
  // every project's chats, for the Chats page (requested on demand)
  allChats: { project: ProjectInfo; chats: ChatMeta[] }[]
  // transcript (per active project; cleared on open)
  items: Item[]
  streaming: Streaming | null
  status: string | null
  recovering: Recovering | null
  busy: boolean
  /** ADR-039: how full the model's context window is (last model call). Survives turn end on purpose — after
   *  a build stops, "how close am I to compaction?" is exactly what you want to see before typing again. */
  context: { used: number; window: number; auto: number } | null
  // ADR-068: the single active turn (server-tracked). Drives the sidebar dot + composer lock; a turn whose
  // projectId ≠ the viewed project keeps running in the background (its events are gated out of this view).
  turnActivity: { projectId?: string; chatId?: string; phase: 'running' | 'awaiting' } | null
  // Liveness: when the current model STEP began (reset at each step boundary), so the UI can tick an elapsed
  // timer — motion the user can see even when the model emits no tokens (prompt eval / a stall). `sawTokens`
  // flips true on the first thinking/text delta of the step, so we can say "Processing input…" (still ingesting
  // the prompt) vs "Thinking…"/streaming once output actually starts.
  stepStartedAt: number | null
  sawTokens: boolean
  /** When the last thinking/text token arrived (this step). With `sawTokens`, lets the UI tell live reasoning
   *  ("Thinking…") from the silent tool-args generation that follows it ("Writing changes…" — nothing streams). */
  lastTokenAt: number | null
  /** When the CURRENT thinking burst began. The live "Thinking… Ns" timer must count from here — counting from
   *  stepStartedAt folded the whole prefill into it ("Thinking… 18s" on 8s of actual thought, corrected only
   *  when the committed card rendered). */
  thinkStartedAt: number | null
  // multiple chats per project (M11), server-persisted; the list + which is active
  chats: ChatMeta[]
  activeChatId: string | null
  // code pane (M4) + diff view (M2)
  fileTree: FileNode[]
  openTabs: string[] // M12: VS Code-style editor tabs — the paths of open files, in tab order. openFile is the active one.
  openFile: { path: string; content: string } | null
  fileDiff: { path: string; original: string; modified: string } | null
  codeView: 'code' | 'diff'
  fileError: string | null // a transient file-operation error to surface in the Code pane (M9), auto-clears
  // live preview (M3)
  preview: PreviewState | null
  // dev-server console logs (M5), newest last; capped to keep memory bounded
  logs: string[]
  // type-check problems (M5.3) + whether a check is currently running
  problems: Problem[]
  checking: boolean
  // build/runtime errors captured from the running preview (Vite overlay + window.onerror)
  runtimeErrors: RuntimeError[]
  // git checkpoint history (M6), newest first
  versions: Version[]
  // VS Code-style bottom panel + integrated terminal (M7)
  bottomTab: BottomTab
  bottomOpen: boolean
  bottomMaximized: boolean
  terminals: string[] // open terminal session ids (order = tab order)
  activeTerminalId: string | null
  // visual editing (M9): in-place edit of an element clicked in the preview (the editing UI lives inside the
  // iframe; the store just arms select mode, persists committed text, and feeds the "AI edit" prefill)
  selectMode: boolean // the preview's "select an element" mode is armed
  composerDraft: string // text to push into the chat composer (e.g. an "AI edit" prefill); '' = none
  // shell
  sidebarCollapsed: boolean
  rightTab: RightTab
  theme: Theme
  accent: string | null // M11 custom theme: brand accent hex (overrides primary/ring), or null for neutral
  customizeOpen: boolean // M11: the "Customize theme" dialog is open
  // transport (injected by App)
  send: (m: WireMessage) => void
  setSend: (send: (m: WireMessage) => void) => void
  // actions
  setConnected: (b: boolean) => void
  handleEvent: (e: WireEvent) => void
  submit: (text: string, images?: string[]) => void
  listModels: (provider: string) => void // ADR-067: ask the server for a provider's models (→ cached in `models`)
  setModel: (provider: string, model: string) => void // ADR-067: switch the active provider/model (no restart)
  fetchModelInfo: (provider: string, model: string) => void // ADR-067: ask for a model's capabilities+context (→ `modelInfo`)
  setApiKey: (provider: string, key: string) => void // ADR-067: set a provider's key on the running server
  setModelManagerOpen: (open: boolean) => void // ADR-067: open/close the model-management dialog
  addModel: (provider: string, model: string, contextWindow?: number, baseUrl?: string, apiKey?: string, api?: 'openai' | 'ollama') => void // ADR-067/076/077: add a model; baseUrl+apiKey+api configure a custom endpoint (remote GPU); api picks the wire protocol
  removeModel: (provider: string, model: string) => void // ADR-067: remove a model from the curated list
  setModelContext: (provider: string, model: string, contextWindow?: number) => void // ADR-067: set a model's context override
  setModelParams: (provider: string, model: string, params: Omit<EnabledModelInfo, 'provider' | 'model'>) => void // ADR-067: merge editable per-model params
  // ADR-071: MCP server management (the MCP panel).
  listMcpServers: () => void
  addMcpServer: (name: string, url: string, opts?: { apiKey?: string; apiKeyIn?: string; headers?: Record<string, string> }) => void
  removeMcpServer: (name: string) => void
  toggleMcpServer: (name: string, disabled: boolean) => void
  answerQuestion: (id: string, answers: import('@cascade/core').Answers) => void // ADR-043
  stop: () => void
  newChat: () => void // M11: start a fresh chat in the active project
  switchChat: (id: string) => void // M11: switch to a saved chat (loads its history)
  deleteChat: (id: string) => void // M11
  renameChat: (id: string, title: string) => void // M11
  requestAllChats: () => void // the Chats page: ask for every project's chat list
  openChat: (projectId: string, chatId: string) => void // the Chats page: open a project AND switch to a chat
  createProject: (name: string, templateId?: string) => void
  openProject: (id: string) => void
  deleteProject: (id: string) => void
  navigate: (page: Page) => void
  openProjectPage: (id: string) => void
  initRouter: () => void // wire the address bar ↔ store (called once by App)
  reopenActive: () => void // re-send `open` for the active project after a (re)connect
  startBuild: (prompt: string, templateId?: string) => void
  toggleSidebar: () => void
  setRightTab: (t: RightTab) => void
  toggleTheme: () => void
  setAccent: (hex: string | null) => void // M11: apply + persist a brand accent
  setCustomizeOpen: (open: boolean) => void // M11: open/close the theme dialog
  requestFile: (path: string) => void
  refreshFiles: () => void // M12: re-request the active project's file tree (explorer refresh button)
  openFileInCode: (path: string, view?: 'code' | 'diff') => void
  closeTab: (path: string) => void // M12: close an editor tab; if it was active, fall to a neighbor
  setCodeView: (v: 'code' | 'diff') => void
  saveFile: (path: string, content: string) => void // M9: persist a Code-pane edit (→ file:write → HMR)
  createFile: (path: string) => void // M9 file tree: new empty file (and open it)
  createFolder: (path: string) => void // M9 file tree: new folder
  renameEntry: (path: string, to: string) => void // M9 file tree: rename/move
  deleteEntry: (path: string) => void // M9 file tree: delete file/folder
  startPreview: () => void
  stopPreview: () => void
  clearLogs: () => void
  runCheck: () => void // M5.3: ask the server to type-check the project
  fixProblems: () => void // M5.3: hand the current problems (type + build/runtime) to the agent to fix
  onPreviewError: (p: RuntimeError | { kind: 'build-cleared' }) => void // a preview error (or its recovery)
  restoreVersion: (id: string) => void // M6: restore the project to a checkpoint
  // bottom panel + terminal (M7)
  setBottomTab: (t: BottomTab) => void
  previewDevice: PreviewDevice // responsive preview viewport (desktop/tablet/mobile)
  setPreviewDevice: (d: PreviewDevice) => void
  toggleBottom: () => void
  toggleBottomMax: () => void
  newTerminal: () => void // add a new terminal session + make it active
  closeTerminal: (id: string) => void
  setActiveTerminal: (id: string) => void
  setTerminalSink: (id: string, fn: ((chunk: string) => void) | undefined) => void // xterm.write per session
  startTerminal: (id: string, cols: number, rows: number) => void
  stopTerminal: (id: string) => void
  terminalInput: (id: string, data: string) => void
  terminalResize: (id: string, cols: number, rows: number) => void
  // visual editing (M9)
  toggleSelectMode: () => void // arm/disarm "select an element" mode
  setSelectMode: (on: boolean) => void
  editPreviewText: (loc: string, tag: string, text: string) => void // commit an in-place edit → write source (splice the JSX)
  setPreviewClass: (loc: string, className: string) => void // M9 toolbar: write a new className to source
  aiEditPreview: (loc: string, tag: string, text: string) => void // hand the element to the chat composer for an AI edit
  setComposerDraft: (text: string) => void // composer reads + clears this (prefill channel)
}

export const useStore = create<UiState>((set, get) => {
  // Batch streaming deltas per animation frame (StreamingOptimizer) so we don't re-render per token.
  const textOpt = new StreamingOptimizer((t) =>
    set((s) => ({ streaming: { text: (s.streaming?.text ?? '') + t, thinking: s.streaming?.thinking ?? '' } })),
  )
  const thinkOpt = new StreamingOptimizer((t) =>
    set((s) => ({ streaming: { text: s.streaming?.text ?? '', thinking: (s.streaming?.thinking ?? '') + t } })),
  )
  const flushStream = () => (textOpt.flush(), thinkOpt.flush())
  // When the model's current thinking burst started (per model step), so a finished message can show
  // "Thought for Ns". Reset after each message and at the start of a turn.
  let thinkStart: number | null = null
  // …and when its LAST thinking token arrived. The gap between thinkLast and the message commit is the model
  // silently generating tool-call arguments (nothing streams on that phase — a 118-line Write is ~20s of
  // dead air), which must NOT be billed as thinking: "Thought for 24s" on 93 chars of reasoning was the tell.
  let thinkLast: number | null = null

  // Commit whatever is still in the live streaming buffer as a real transcript item. Used when a turn ends
  // WITHOUT a final `message` (user hit Stop, server abort): previously this content was silently discarded
  // (`streaming: null`), so an interrupted thinking block just vanished from the transcript.
  // Quiet-debounce for the early thought-commit: armed on every thinking token, so it can only ever fire
  // 2.5s after the TRULY last one — on the same task queue as the event handlers. (The first version lived in
  // a ChatPanel useEffect: render-clock timing raced the event clock and could chop a resumed burst mid-stream,
  // landing the thought card in the wrong place. Single writer, single clock — the store.)
  let quietTimer: ReturnType<typeof setTimeout> | null = null
  const clearQuiet = (): void => {
    if (quietTimer !== null) { clearTimeout(quietTimer); quietTimer = null }
  }

  const commitStreaming = (): void => {
    clearQuiet()
    flushStream()
    const st = get().streaming
    if (!st || (!st.text && !st.thinking)) return
    const thoughtMs = st.thinking && thinkStart !== null ? Math.max(0, (thinkLast ?? Date.now()) - thinkStart) : undefined
    thinkStart = null
    thinkLast = null
    set((s) => ({ items: [...s.items, { kind: 'assistant', text: st.text, thinking: st.thinking || undefined, thoughtMs }], streaming: null, thinkStartedAt: null }))
  }

  // M7: per-terminal-session xterm.write sinks (imperative — kept out of React state). TerminalPane registers
  // its writer here on mount; `terminalData` events route to the matching session.
  const terminalSinks = new Map<string, (chunk: string) => void>()
  let termSeq = 0 // monotonic id source for new terminal sessions

  // M9: the last in-place edit's context, so if the server refuses the splice (non-plain-text element) we can
  // fall back to an AI edit with the right file/line. data-cascade-loc is "file:line:col" (1-based line, 0-based
  // col, from Babel); parse from the right so a relative path's own characters don't confuse the split.
  let lastEditCtx: { file: string; line: number; tag: string; text: string } | null = null
  const parseLoc = (loc: string) => {
    const m = loc.match(/^(.*):(\d+):(\d+)$/)
    return m ? { file: m[1], line: Number(m[2]), col: Number(m[3]) } : null
  }

  // ── URL routing (History API; no react-router). The in-store `page`/`activeId` is the source of truth;
  // these keep the address bar in sync so a project shows /project/<slug>, and reload/back/forward work. ──
  const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project'
  // The URL slug carries the project's short id (same convention as its dir: `<slug>-<id[:8]>`), so two
  // projects with the same name still get DISTINCT, reliably-resolvable URLs.
  const shortId = (id: string) => id.slice(0, 8)
  const projectParam = (p: { id: string; name: string }) => `${slugify(p.name)}-${shortId(p.id)}`
  const projectPath = (p: { id: string; name: string }) => `/project/${projectParam(p)}`
  // Resolve a /project/<param> back to a project: exact match first (name+id), then by trailing id (so a
  // future rename, or any slug drift, still resolves via the stable id).
  const resolveParam = (param: string, projects: ProjectInfo[]) =>
    projects.find((p) => projectParam(p) === param) ?? projects.find((p) => param.endsWith(`-${shortId(p.id)}`) || param === shortId(p.id))
  const pathForPage = (page: Page) => (page === 'home' ? '/' : `/${page}`)
  const pushUrl = (path: string) => {
    if (typeof location !== 'undefined' && location.pathname !== path) history.pushState({}, '', path)
  }
  // Parse the address bar and reflect it into the store WITHOUT pushing history (used on load + popstate).
  const applyPath = (path: string) => {
    const m = path.match(/^\/project\/([^/]+)/)
    if (m) {
      const param = decodeURIComponent(m[1])
      const p = resolveParam(param, get().projects)
      if (p) {
        set({ page: 'project', pendingSlug: null, slugNotFound: null })
        get().openProject(p.id) // sends `open`; doesn't push (URL already reflects it)
      } else if (get().projects.length > 0) {
        // The list is loaded and this slug matches nothing (deleted project / mistyped URL) — say so
        // explicitly rather than silently rendering some other page at this URL.
        set({ page: 'project', pendingSlug: null, slugNotFound: param, activeId: null })
      } else {
        set({ page: 'project', pendingSlug: param, slugNotFound: null }) // projects not loaded yet — resolve when they arrive
      }
      return
    }
    const page: Page = path === '/projects' ? 'projects' : path === '/chats' ? 'chats' : path === '/settings' ? 'settings' : path === '/mcp' ? 'mcp' : 'home'
    set({ page, pendingSlug: null, slugNotFound: null })
  }

  return {
    page: 'home',
    pendingPrompt: null,
    pendingSlug: null,
    slugNotFound: null,
    connected: false,
    serverInfo: null,
    models: {},
    modelInfo: {},
    modelManagerOpen: false,
    enabledModels: [],
    mcpServers: [],
    projects: [],
    templates: [],
    activeId: null,
    allChats: [],
    items: [],
    streaming: null,
    status: null,
    recovering: null,
    busy: false,
    context: null,
    turnActivity: null,
    stepStartedAt: null,
    sawTokens: false,
    lastTokenAt: null,
    thinkStartedAt: null,
    chats: [],
    activeChatId: null,
    fileTree: [],
    openTabs: [],
    openFile: null,
    fileError: null,
    fileDiff: null,
    codeView: 'code',
    preview: null,
    logs: [],
    problems: [],
    checking: false,
    runtimeErrors: [],
    versions: [],
    bottomTab: 'terminal',
    previewDevice: 'desktop',
    bottomOpen: false, // M12: terminal/bottom panel starts CLOSED (VS Code-like); opens on demand (Terminal button / Ctrl+`)
    bottomMaximized: false,
    terminals: [],
    activeTerminalId: null,
    selectMode: false,
    composerDraft: '',
    sidebarCollapsed: false,
    rightTab: 'preview',
    theme: getInitialTheme(),
    accent: getInitialAccent(),
    customizeOpen: false,
    send: () => {},
    setSend: (send) => set({ send }),
    setConnected: (connected) => {
      // A dropped socket killed every terminal shell server-side (ws close → killAllTerms). Drop the dead
      // tabs (and their xterm sinks) so a reconnect starts fresh instead of showing blank zombie terminals.
      if (!connected) {
        terminalSinks.clear()
        set({ connected, terminals: [], activeTerminalId: null })
        return
      }
      set({ connected })
    },

    handleEvent: (e) => {
      // ADR-068: a turn belonging to a DIFFERENT project than the one on screen keeps running in the
      // background — its transcript events must not leak into this view. They're logged server-side and
      // re-attached (replay + live snapshot) when the user returns to that project. Non-turn events
      // (projects/turnActivity/files/preview/…) are never gated.
      const ta = get().turnActivity
      if (ta && ta.projectId && ta.projectId !== get().activeId && TURN_EVENTS.has(e.type)) return

      switch (e.type) {
        case 'turnActivity': // ADR-068: the single active turn changed (running / awaiting / done)
          if (!e.phase) commitStreaming() // turn ended (Stop/abort/done) → keep any in-flight thinking as a real item, don't vanish it
          set({
            turnActivity: e.phase ? { projectId: e.projectId, chatId: e.chatId, phase: e.phase } : null,
            busy: !!e.phase, // block-until-free: any active turn locks the composer everywhere
            ...(e.phase ? {} : { streaming: null, status: null, stepStartedAt: null, sawTokens: false }),
          })
          break
        case 'step':
          // Core's explicit step-start (the dead-air contract): prefill begins NOW — restart the
          // per-step timer and drop back to "reading input" until the first delta. NEVER touches
          // `busy`: only turnDone may declare the work finished.
          clearQuiet()
          set({ stepStartedAt: Date.now(), sawTokens: false, recovering: null, thinkStartedAt: null })
          break
        case 'status':
          set({ status: e.text, recovering: null })
          break
        case 'recovering':
          flushStream()
          set({ streaming: null, status: null, recovering: { attempt: e.attempt, reason: e.reason } })
          break
        case 'thinking_delta': {
          const firstOfBurst = thinkStart === null
          if (firstOfBurst) thinkStart = Date.now()
          thinkLast = Date.now()
          // first token → past prompt eval, now generating; the burst start feeds the live timer (NOT stepStartedAt — that includes prefill)
          set({ recovering: null, sawTokens: true, lastTokenAt: thinkLast, ...(firstOfBurst ? { thinkStartedAt: thinkStart } : {}) })
          thinkOpt.push(e.thinking)
          // Re-armed on EVERY token: fires only 2.5s after the last one → commit the thought block right when
          // thinking ends (not 10-20s later when `message` finally arrives after silent tool-args generation).
          clearQuiet()
          quietTimer = setTimeout(() => {
            quietTimer = null
            const st = get().streaming
            if (st?.thinking && !st.text) commitStreaming()
          }, 2500)
          break
        }
        case 'text_delta':
          clearQuiet() // prose answer streaming — the step will end with `message`; never early-commit mid-answer
          set({ recovering: null, sawTokens: true, lastTokenAt: Date.now() })
          textOpt.push(e.text)
          break
        case 'toolStart':
          flushStream()
          set((s) => ({
            streaming: null,
            recovering: null,
            items: [...s.items, { kind: 'tool', id: e.id, name: e.name, summary: e.summary, status: 'running' }],
          }))
          break
        case 'toolProgress':
          set((s) => ({
            items: s.items.map((x) =>
              x.kind === 'tool' && x.id === e.id ? { ...x, preview: `${x.preview ?? ''}${e.chunk}`.slice(-4000) } : x,
            ),
          }))
          break
        case 'toolResult':
          set((s) => ({
            items: s.items.map((x) =>
              x.kind === 'tool' && x.id === e.id ? { ...x, status: e.ok ? 'ok' : 'error', preview: e.preview, display: e.display } : x,
            ),
            // The model resumes after a tool → a fresh step begins (with its own prompt-eval gap).
            stepStartedAt: Date.now(),
            sawTokens: false,
          }))
          break
        case 'message': {
          flushStream()
          const { text, thinking } = extractMessage(e.message)
          // Clock stops at the LAST thinking token: everything after it was silent tool-args generation.
          const thoughtMs = thinking && thinkStart !== null ? Math.max(0, (thinkLast ?? Date.now()) - thinkStart) : undefined
          thinkStart = null
          thinkLast = null
          // (thinkStartedAt cleared in the set()s below via streaming reset paths; explicit here for safety)
          set({ thinkStartedAt: null })
          set((s) => {
            // Merge consecutive assistant steps (no tool/user turn between) into one flowing block, so a
            // multi-step turn reads as a single response — like v0. A tool card between steps breaks the run.
            const last = s.items[s.items.length - 1]
            if (last && last.kind === 'assistant') {
              // Early-commit dedup: if this message's thinking was already committed verbatim when the stream
              // went quiet (commitStreamingEarly), keep the committed copy — don't append it a second time.
              const dupThinking = !!last.thinking && !!thinking && last.thinking.trim() === thinking.trim()
              const merged: Item = {
                kind: 'assistant',
                text: last.text + (last.text && text ? '\n\n' : '') + text,
                thinking: dupThinking ? last.thinking : [last.thinking, thinking].filter(Boolean).join('\n\n') || undefined,
                thoughtMs: dupThinking ? last.thoughtMs : (last.thoughtMs ?? 0) + (thoughtMs ?? 0) || undefined,
              }
              return { items: [...s.items.slice(0, -1), merged], streaming: null, stepStartedAt: Date.now(), sawTokens: false }
            }
            return { items: [...s.items, { kind: 'assistant', text, thinking: thinking || undefined, thoughtMs }], streaming: null, stepStartedAt: Date.now(), sawTokens: false }
          })
          break
        }
        case 'memory':
          set((s) => ({ items: [...s.items, { kind: 'memory', text: e.text }] }))
          break
        case 'question': // ADR-043: the agent is asking; the loop is parked until the user answers
          flushStream()
          set((s) => ({ streaming: null, recovering: null, items: [...s.items, { kind: 'question', id: e.id, questions: e.questions }] }))
          break
        case 'compacted':
          set((s) => ({
            items: [...s.items, { kind: 'compacted', text: compactedLabel(e.kind) }],
          }))
          break
        case 'context':
          set({ context: { used: e.used, window: e.window, auto: e.auto } })
          break
        case 'turnDone':
          commitStreaming() // an aborted turn's in-flight thinking/text becomes a transcript item (was: discarded)
          thinkStart = null
          thinkLast = null
          set({ status: null, recovering: null, busy: false, stepStartedAt: null, sawTokens: false, thinkStartedAt: null })
          break
        // ── app/builder events (BuilderEvent) ──
        case 'serverInfo':
          set({ serverInfo: { sandbox: e.sandbox, model: e.model, provider: e.provider, providers: e.providers } })
          break
        case 'models': // ADR-067: a provider's model list arrived → cache it for the picker
          set((s) => ({ models: { ...s.models, [e.provider]: e.models } }))
          break
        case 'modelInfo': // ADR-067: one model's capabilities+context → cache for the manager
          set((s) => ({ modelInfo: { ...s.modelInfo, [`${e.provider}/${e.model}`]: { capabilities: e.capabilities, contextWindow: e.contextWindow, limits: e.limits } } }))
          break
        case 'mcpServers': // ADR-071: configured MCP servers + status
          set({ mcpServers: e.servers })
          break
        case 'enabledModels': // ADR-067: the curated picker list
          set({ enabledModels: e.models })
          break
        case 'allChats':
          set({ allChats: e.groups })
          break
        case 'projects': {
          set({ projects: e.projects })
          // If we arrived on a /project/<slug> URL before the list loaded, resolve it now.
          const { pendingSlug, page } = get()
          if (page === 'project' && pendingSlug) {
            const p = resolveParam(pendingSlug, e.projects)
            if (p) {
              set({ pendingSlug: null, slugNotFound: null })
              get().openProject(p.id)
            } else {
              // The list has arrived and the slug matches nothing → an explicit not-found, not a silent home.
              set({ pendingSlug: null, slugNotFound: pendingSlug })
            }
          } else if (e.activeId) set({ activeId: e.activeId })
          break
        }
        case 'projectCreated': {
          // Home flow: a project was just created for a build prompt — open it, go to its builder, send the prompt.
          const pending = get().pendingPrompt
          if (pending) {
            set({ pendingPrompt: null })
            get().openProjectPage(e.project.id)
            get().submit(pending)
          }
          break
        }
        case 'templates':
          set({ templates: e.templates })
          break
        case 'files':
          set({ fileTree: e.tree })
          break
        case 'fileContent':
          // Set the active file AND ensure it has a tab (covers created files, which the server opens by
          // pushing fileContent without a prior openFileInCode call).
          set((s) => ({ openFile: { path: e.path, content: e.content }, openTabs: s.openTabs.includes(e.path) ? s.openTabs : [...s.openTabs, e.path] }))
          break
        case 'fileEdited':
          // M9: a visual edit landed. ok:false ⇒ the element wasn't a plain-text container (nested
          // elements/expressions), so fall back to an AI edit by prefilling the composer with its context.
          if (!e.ok && lastEditCtx) get().aiEditPreview(`${lastEditCtx.file}:${lastEditCtx.line}:0`, lastEditCtx.tag, lastEditCtx.text)
          break
        case 'fileOpError': {
          // M9 file-tree op failed (name collision, etc). Surface it briefly in the Code pane.
          set({ fileError: e.message })
          setTimeout(() => set((s) => (s.fileError === e.message ? { fileError: null } : {})), 4000)
          break
        }
        case 'chats':
          set({ chats: e.chats, activeChatId: e.activeId })
          break
        case 'chatHistory': {
          // M11: render a switched-to chat's saved transcript.
          // GUARD (measured in the first live walkthrough): the Home flow sends `open` + `submit`
          // back-to-back, and the open's chatHistory reply (an EMPTY saved chat) landed AFTER the
          // optimistic user message — wiping the pane while the plan stage ran, so the app looked
          // stuck for minutes. Skip only an EMPTY history while busy; a NON-empty history is a real
          // restore (ADR-068: returning to a running chat) and must load, then re-attach live.
          if (get().busy && !e.events?.length) break
          if (e.events?.length) {
            // High-fidelity path: RE-DISPATCH the logged live events through this very reducer — the
            // reloaded transcript is the live transcript by construction (tool cards with status/diffs/
            // previews, thinking blocks, compaction dividers; only thought-timing is lost, since that
            // was measured client-side). The `user` entries are the submits (not ActivityEvents).
            set({ items: [], streaming: null, status: null })
            for (const entry of e.events) {
              if (typeof entry === 'object' && entry !== null && 'user' in entry) {
                set((s) => ({ items: [...s.items, { kind: 'user', text: String((entry as { user: string }).user) }] }))
              } else if (typeof entry === 'object' && entry !== null && 'event' in entry) {
                get().handleEvent((entry as { event: never }).event)
              }
            }
            set({ streaming: null, status: null, busy: false, recovering: null, stepStartedAt: null, sawTokens: false })
            break
          }
          // LEGACY fallback (chats recorded before the replay log): the flattened rows.
          set({
            items: e.items.map((it, i): Item =>
              it.role === 'user'
                ? { kind: 'user', text: it.text }
                : it.role === 'assistant'
                  ? { kind: 'assistant', text: it.text }
                  : { kind: 'tool', id: `h${i}`, name: it.name ?? 'tool', summary: it.text || (it.name ?? 'tool'), status: 'ok' },
            ),
            streaming: null,
            status: null,
            busy: false,
            context: null, // a different chat has a different history — occupancy is unknown until it next calls the model
          })
          break
        }
        case 'fileDiff':
          set({ fileDiff: { path: e.path, original: e.original, modified: e.modified } })
          break
        case 'preview':
          set({ preview: { status: e.status, url: e.url, error: e.error } })
          break
        case 'log':
          set((s) => ({ logs: [...s.logs, e.line].slice(-2000) }))
          break
        case 'problems':
          set({ problems: e.problems, checking: e.checking ?? false })
          break
        case 'versions':
          set({ versions: e.versions })
          break
        case 'terminalData':
          terminalSinks.get(e.id)?.(e.data)
          break
        case 'terminalExit':
          terminalSinks.get(e.id)?.('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
          break
      }
    },

    submit: (text, images) => {
      const t = text.trim()
      const { connected, activeId, send } = get()
      if ((!t && !images?.length) || !connected || !activeId) return
      const label = images?.length ? `${t}${t ? '\n\n' : ''}📎 ${images.length} image${images.length > 1 ? 's' : ''}` : t
      set((s) => ({ items: [...s.items, { kind: 'user', text: label }], busy: true, stepStartedAt: Date.now(), sawTokens: false }))
      send({ type: 'submit', text: t, images })
    },

    // ADR-067: the runtime model picker + manager.
    listModels: (provider) => get().send({ type: 'listModels', provider }),
    setModel: (provider, model) =>
      set((s) => {
        s.send({ type: 'setModel', provider, model })
        // optimistic: reflect the choice immediately (the server confirms with a fresh serverInfo)
        return { serverInfo: s.serverInfo ? { ...s.serverInfo, provider, model } : s.serverInfo }
      }),
    fetchModelInfo: (provider, model) => get().send({ type: 'modelInfo', provider, model }),
    setApiKey: (provider, key) => get().send({ type: 'setApiKey', provider, key }),
    setModelManagerOpen: (open) => set({ modelManagerOpen: open }),
    addModel: (provider, model, contextWindow, baseUrl, apiKey, api) => get().send({ type: 'addModel', provider, model, contextWindow, baseUrl, apiKey, api }),
    listMcpServers: () => get().send({ type: 'listMcpServers' }),
    addMcpServer: (name, url, opts) => get().send({ type: 'addMcpServer', name, url, apiKey: opts?.apiKey, apiKeyIn: opts?.apiKeyIn, headers: opts?.headers }),
    removeMcpServer: (name) => get().send({ type: 'removeMcpServer', name }),
    toggleMcpServer: (name, disabled) => get().send({ type: 'toggleMcpServer', name, disabled }),
    removeModel: (provider, model) => get().send({ type: 'removeModel', provider, model }),
    setModelContext: (provider, model, contextWindow) => get().send({ type: 'setModelContext', provider, model, contextWindow }),
    setModelParams: (provider, model, params) => get().send({ type: 'setModelParams', provider, model, params }),

    // ADR-043: deliver the user's answer to a `question` event → wakes the parked agent loop; mark the card done.
    answerQuestion: (id, answers) => {
      get().send({ type: 'answer', id, answers })
      set((s) => ({ items: s.items.map((x) => (x.kind === 'question' && x.id === id ? { ...x, answered: answers } : x)) }))
    },
    stop: () => {
      get().send({ type: 'abort' })
      set({ busy: false, status: null, stepStartedAt: null, sawTokens: false })
    },
    // ── multiple chats per project (M11) — the server owns the list + history; we just drive it ──
    newChat: () => get().send({ type: 'chat', action: 'new' }),
    switchChat: (id) => {
      if (id !== get().activeChatId) get().send({ type: 'chat', action: 'switch', id })
    },
    deleteChat: (id) => get().send({ type: 'chat', action: 'delete', id }),
    renameChat: (id, title) => get().send({ type: 'chat', action: 'rename', id, title }),
    createProject: (name, templateId) => {
      const n = name.trim()
      if (n) get().send({ type: 'project', action: 'create', name: n, templateId })
    },
    openProject: (id) => {
      if (id === get().activeId) return
      // Set activeId optimistically so submit() works before the server's `projects` snapshot round-trips.
      terminalSinks.clear() // the server kills the old project's shells on switch; drop their writers
      // ADR-068: keep the composer locked if a turn is still running elsewhere (block-until-free); its view
      // restores when we open it, or when the server re-attaches this project's own live turn.
      set({ activeId: id, items: [], streaming: null, status: null, busy: !!get().turnActivity, stepStartedAt: null, sawTokens: false, chats: [], activeChatId: null, fileTree: [], openTabs: [], openFile: null, fileError: null, fileDiff: null, codeView: 'code', preview: null, logs: [], problems: [], checking: false, runtimeErrors: [], versions: [], terminals: [], activeTerminalId: null, selectMode: false })
      get().send({ type: 'project', action: 'open', id })
    },
    deleteProject: (id) => {
      get().send({ type: 'project', action: 'delete', id })
      if (id === get().activeId) {
        set({ activeId: null, items: [], page: 'projects', pendingSlug: null })
        pushUrl('/projects')
      }
    },
    navigate: (page) => {
      set({ page, pendingSlug: null, slugNotFound: null })
      pushUrl(pathForPage(page))
    },
    openProjectPage: (id) => {
      get().openProject(id)
      set({ page: 'project', pendingSlug: null, slugNotFound: null })
      const p = get().projects.find((x) => x.id === id)
      if (p) pushUrl(projectPath(p))
    },
    requestAllChats: () => get().send({ type: 'chats', action: 'listAll' }),
    openChat: (projectId, chatId) => {
      // Open the project first, then switch to the chat — same socket, ordered, so the server processes
      // `open` (which attaches the session) before `chat switch`.
      get().openProjectPage(projectId)
      get().send({ type: 'chat', action: 'switch', id: chatId })
    },
    initRouter: () => {
      applyPath(location.pathname)
      window.addEventListener('popstate', () => applyPath(location.pathname))
    },
    reopenActive: () => {
      const id = get().activeId
      if (id) get().send({ type: 'project', action: 'open', id })
    },
    startBuild: (prompt, templateId) => {
      const p = prompt.trim()
      if (!p || !get().connected) return
      // Create a project (named from the prompt), then projectCreated → open + go to builder + send the prompt.
      const name = p.replace(/\s+/g, ' ').split(' ').slice(0, 6).join(' ').slice(0, 48) || 'New project'
      set({ pendingPrompt: p })
      get().send({ type: 'project', action: 'create', name, templateId })
    },
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    setRightTab: (rightTab) => set({ rightTab }),
    requestFile: (path) => get().send({ type: 'file', action: 'read', path }),
    refreshFiles: () => get().send({ type: 'files', action: 'list' }),
    openFileInCode: (path, view = 'code') => {
      // M12: add to the tab strip (dedup, preserve order) and make it active. openFile is set when the
      // server's fileContent arrives; openTabs holds every open path so the strip survives tab switches.
      set((s) => ({ rightTab: 'code', codeView: view, openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path] }))
      get().requestFile(path)
      if (view === 'diff') get().send({ type: 'file', action: 'diff', path })
    },
    closeTab: (path) => {
      const { openTabs, openFile } = get()
      const idx = openTabs.indexOf(path)
      const next = openTabs.filter((p) => p !== path)
      set({ openTabs: next })
      if (openFile?.path !== path) return // closed a background tab — active file unchanged
      // Closed the active tab: fall to the neighbor (prefer the one to the left, else the new head).
      const fallback = next[idx - 1] ?? next[0]
      if (fallback) get().openFileInCode(fallback, get().codeView)
      else set({ openFile: null, fileDiff: null }) // last tab closed — empty editor
    },
    setCodeView: (codeView) => {
      set({ codeView })
      const f = get().openFile
      if (codeView === 'diff' && f && get().fileDiff?.path !== f.path) get().send({ type: 'file', action: 'diff', path: f.path })
    },
    saveFile: (path, content) => {
      set((s) => (s.openFile?.path === path ? { openFile: { path, content } } : {})) // keep local buffer authoritative
      get().send({ type: 'file', action: 'write', path, content })
    },
    createFile: (path) => get().send({ type: 'file', action: 'create', path }), // server replies with fileContent → opens it
    createFolder: (path) => get().send({ type: 'file', action: 'mkdir', path }),
    renameEntry: (path, to) => {
      get().send({ type: 'file', action: 'rename', path, to })
      // Follow the renamed path in the tab strip (the file itself, or any tab under a renamed dir).
      set((s) => ({ openTabs: s.openTabs.map((p) => (p === path ? to : p.startsWith(`${path}/`) ? to + p.slice(path.length) : p)) }))
      if (get().openFile?.path === path) get().openFileInCode(to) // follow the open file to its new path
    },
    deleteEntry: (path) => {
      get().send({ type: 'file', action: 'delete', path })
      // Drop the deleted path (or any tab under a deleted dir) from the strip.
      set((s) => ({ openTabs: s.openTabs.filter((p) => p !== path && !p.startsWith(`${path}/`)) }))
      const open = get().openFile?.path
      if (open && (open === path || open.startsWith(`${path}/`))) {
        const remaining = get().openTabs
        if (remaining.length) get().openFileInCode(remaining[remaining.length - 1], get().codeView)
        else set({ openFile: null, fileDiff: null }) // it (or its dir) is gone, nothing left to show
      }
    },
    startPreview: () => {
      set({ preview: { status: 'installing' } }) // optimistic; server confirms via `preview` events
      get().send({ type: 'preview', action: 'start' })
    },
    stopPreview: () => {
      get().send({ type: 'preview', action: 'stop' })
      set({ preview: null })
    },
    clearLogs: () => set({ logs: [] }),
    runCheck: () => {
      if (!get().activeId) return
      set({ checking: true, problems: [] })
      get().send({ type: 'check' })
    },
    fixProblems: () => {
      const { problems, runtimeErrors, submit } = get()
      if (!problems.length && !runtimeErrors.length) return
      const parts: string[] = []
      if (problems.length) parts.push('TypeScript errors:\n' + problems.map((p) => `- ${p.file}(${p.line},${p.col}): ${p.message}`).join('\n'))
      if (runtimeErrors.length) parts.push('Build/runtime errors from the preview:\n' + runtimeErrors.map((e) => `- ${e.file ? `${e.file}: ` : ''}${e.message}`).join('\n'))
      submit(`Fix these errors so the project type-checks, builds, and runs cleanly:\n\n${parts.join('\n\n')}`)
    },
    onPreviewError: (p) =>
      set((s) => {
        if (p.kind === 'build-cleared') return { runtimeErrors: s.runtimeErrors.filter((e) => e.kind !== 'build') }
        if (p.kind === 'build') return { runtimeErrors: [p, ...s.runtimeErrors.filter((e) => e.kind !== 'build')] } // keep only the latest build error
        if (s.runtimeErrors.some((e) => e.kind === 'runtime' && e.message === p.message)) return {} // dedupe runtime
        return { runtimeErrors: [...s.runtimeErrors, p].slice(-30) }
      }),
    restoreVersion: (id) => get().send({ type: 'version', action: 'restore', id }),
    setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
    setPreviewDevice: (previewDevice) => set({ previewDevice }),
    toggleBottom: () => set((s) => ({ bottomOpen: !s.bottomOpen, bottomMaximized: false })),
    toggleBottomMax: () => set((s) => ({ bottomMaximized: !s.bottomMaximized, bottomOpen: true })),
    newTerminal: () => {
      const id = `t${++termSeq}`
      set((s) => ({ terminals: [...s.terminals, id], activeTerminalId: id, bottomTab: 'terminal', bottomOpen: true }))
    },
    closeTerminal: (id) => {
      get().send({ type: 'terminal', action: 'stop', id })
      terminalSinks.delete(id)
      set((s) => {
        const terminals = s.terminals.filter((t) => t !== id)
        const activeTerminalId = s.activeTerminalId === id ? (terminals[terminals.length - 1] ?? null) : s.activeTerminalId
        return { terminals, activeTerminalId }
      })
    },
    setActiveTerminal: (activeTerminalId) => set({ activeTerminalId }),
    setTerminalSink: (id, fn) => {
      if (fn) terminalSinks.set(id, fn)
      else terminalSinks.delete(id)
    },
    startTerminal: (id, cols, rows) => {
      if (get().activeId) get().send({ type: 'terminal', action: 'start', id, cols, rows })
    },
    stopTerminal: (id) => get().send({ type: 'terminal', action: 'stop', id }),
    terminalInput: (id, data) => get().send({ type: 'terminalInput', id, data }),
    terminalResize: (id, cols, rows) => get().send({ type: 'terminalResize', id, cols, rows }),
    // ── visual editing (M9) ───────────────────────────────────────────────────────────────────────────
    toggleSelectMode: () => set((s) => ({ selectMode: !s.selectMode })),
    setSelectMode: (selectMode) => set({ selectMode }),
    editPreviewText: (loc, tag, text) => {
      const p = parseLoc(loc)
      if (!p) return
      lastEditCtx = { file: p.file, line: p.line, tag, text } // remembered for the AI fallback if the splice is refused
      get().send({ type: 'file', action: 'editText', path: p.file, line: p.line, col: p.col, text })
    },
    setPreviewClass: (loc, className) => {
      const p = parseLoc(loc)
      if (p) get().send({ type: 'file', action: 'setClass', path: p.file, line: p.line, col: p.col, className })
    },
    aiEditPreview: (loc, tag, text) => {
      const p = parseLoc(loc)
      if (!p) return
      const quoted = text ? ` ("${text.slice(0, 80)}")` : ''
      set({ composerDraft: `In ${p.file}:${p.line}, the <${tag}> element${quoted}: ` })
    },
    setComposerDraft: (composerDraft) => set({ composerDraft }),
    toggleTheme: () => {
      const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
      applyTheme(theme)
      set({ theme })
    },
    setAccent: (accent) => {
      applyAccent(accent)
      set({ accent })
    },
    setCustomizeOpen: (customizeOpen) => set({ customizeOpen }),
  }
})
