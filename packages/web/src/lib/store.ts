// store.ts — the web app's single source of UI state (zustand).
// It owns connection + projects + transcript + shell state, the WireEvent handler, and the actions the
// UI calls. The WebSocket transport is injected once (setSend) by App. Settings/permissions/MCP are
// session/wrapper concerns and deliberately NOT kept here — only pure UI state lives in the store.

import { create } from 'zustand'
import type { WireEvent, WireMessage } from './wsClient'
import { extractMessage, type BottomTab, type Item, type Page, type PreviewState, type Recovering, type RightTab, type RuntimeError, type Streaming } from './types'
import { StreamingOptimizer } from './streamingOptimizer'
import { applyAccent, applyTheme, getInitialAccent, getInitialTheme, type Theme } from './theme'
import type { ChatMeta, FileNode, Problem, ProjectInfo, TemplateInfo, Version } from '@cascade/app-protocol'

interface UiState {
  // routing (lightweight in-store router)
  page: Page
  pendingPrompt: string | null // a Home prompt waiting for its project to be created
  pendingSlug: string | null // a /project/<slug> URL awaiting the projects list to resolve it
  // connection + projects
  connected: boolean
  projects: ProjectInfo[]
  templates: TemplateInfo[]
  activeId: string | null
  // transcript (per active project; cleared on open)
  items: Item[]
  streaming: Streaming | null
  status: string | null
  recovering: Recovering | null
  busy: boolean
  // multiple chats per project (M11), server-persisted; the list + which is active
  chats: ChatMeta[]
  activeChatId: string | null
  // code pane (M4) + diff view (M2)
  fileTree: FileNode[]
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
  submit: (text: string) => void
  stop: () => void
  newChat: () => void // M11: start a fresh chat in the active project
  switchChat: (id: string) => void // M11: switch to a saved chat (loads its history)
  deleteChat: (id: string) => void // M11
  renameChat: (id: string, title: string) => void // M11
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
  openFileInCode: (path: string, view?: 'code' | 'diff') => void
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
        set({ page: 'project', pendingSlug: null })
        get().openProject(p.id) // sends `open`; doesn't push (URL already reflects it)
      } else {
        set({ page: 'project', pendingSlug: param }) // projects not loaded yet — resolve when they arrive
      }
      return
    }
    const page: Page = path === '/projects' ? 'projects' : path === '/chats' ? 'chats' : path === '/settings' ? 'settings' : 'home'
    set({ page, pendingSlug: null })
  }

  return {
    page: 'home',
    pendingPrompt: null,
    pendingSlug: null,
    connected: false,
    projects: [],
    templates: [],
    activeId: null,
    items: [],
    streaming: null,
    status: null,
    recovering: null,
    busy: false,
    chats: [],
    activeChatId: null,
    fileTree: [],
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
    bottomOpen: true,
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
    setConnected: (connected) => set({ connected }),

    handleEvent: (e) => {
      switch (e.type) {
        case 'status':
          set({ status: e.text, recovering: null })
          break
        case 'recovering':
          flushStream()
          set({ streaming: null, status: null, recovering: { attempt: e.attempt, reason: e.reason } })
          break
        case 'thinking_delta':
          if (thinkStart === null) thinkStart = Date.now()
          set({ recovering: null })
          thinkOpt.push(e.thinking)
          break
        case 'text_delta':
          set({ recovering: null })
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
          }))
          break
        case 'message': {
          flushStream()
          const { text, thinking } = extractMessage(e.message)
          const thoughtMs = thinking && thinkStart !== null ? Date.now() - thinkStart : undefined
          thinkStart = null
          set((s) => {
            // Merge consecutive assistant steps (no tool/user turn between) into one flowing block, so a
            // multi-step turn reads as a single response — like v0. A tool card between steps breaks the run.
            const last = s.items[s.items.length - 1]
            if (last && last.kind === 'assistant') {
              const merged: Item = {
                kind: 'assistant',
                text: last.text + (last.text && text ? '\n\n' : '') + text,
                thinking: [last.thinking, thinking].filter(Boolean).join('\n\n') || undefined,
                thoughtMs: (last.thoughtMs ?? 0) + (thoughtMs ?? 0) || undefined,
              }
              return { items: [...s.items.slice(0, -1), merged], streaming: null }
            }
            return { items: [...s.items, { kind: 'assistant', text, thinking: thinking || undefined, thoughtMs }], streaming: null }
          })
          break
        }
        case 'memory':
          set((s) => ({ items: [...s.items, { kind: 'memory', text: e.text }] }))
          break
        case 'compacted':
          set((s) => ({
            items: [...s.items, { kind: 'compacted', text: e.kind === 'summarized' ? 'summarized older turns' : 'masked old tool output' }],
          }))
          break
        case 'turnDone':
          flushStream()
          thinkStart = null
          set({ status: null, recovering: null, busy: false })
          break
        // ── app/builder events (BuilderEvent) ──
        case 'projects': {
          set({ projects: e.projects })
          // If we arrived on a /project/<slug> URL before the list loaded, resolve it now.
          const { pendingSlug, page } = get()
          if (page === 'project' && pendingSlug) {
            const p = resolveParam(pendingSlug, e.projects)
            if (p) {
              set({ pendingSlug: null })
              get().openProject(p.id)
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
          set({ openFile: { path: e.path, content: e.content } })
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
        case 'chatHistory':
          // M11: render a switched-to chat's saved transcript (flattened rows → transcript items).
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
          })
          break
        case 'fileDiff':
          set({ fileDiff: { path: e.path, original: e.original, modified: e.modified } })
          break
        case 'preview':
          set({ preview: { status: e.status, url: e.url } })
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

    submit: (text) => {
      const t = text.trim()
      const { connected, activeId, send } = get()
      if (!t || !connected || !activeId) return
      set((s) => ({ items: [...s.items, { kind: 'user', text: t }], busy: true }))
      send({ type: 'submit', text: t })
    },
    stop: () => {
      get().send({ type: 'abort' })
      set({ busy: false, status: null })
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
      set({ activeId: id, items: [], streaming: null, status: null, busy: false, chats: [], activeChatId: null, fileTree: [], openFile: null, fileError: null, fileDiff: null, codeView: 'code', preview: null, logs: [], problems: [], checking: false, runtimeErrors: [], versions: [], terminals: [], activeTerminalId: null, selectMode: false })
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
      set({ page, pendingSlug: null })
      pushUrl(pathForPage(page))
    },
    openProjectPage: (id) => {
      get().openProject(id)
      set({ page: 'project', pendingSlug: null })
      const p = get().projects.find((x) => x.id === id)
      if (p) pushUrl(projectPath(p))
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
    openFileInCode: (path, view = 'code') => {
      set({ rightTab: 'code', codeView: view })
      get().requestFile(path)
      if (view === 'diff') get().send({ type: 'file', action: 'diff', path })
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
      if (get().openFile?.path === path) get().openFileInCode(to) // follow the open file to its new path
    },
    deleteEntry: (path) => {
      get().send({ type: 'file', action: 'delete', path })
      const open = get().openFile?.path
      if (open && (open === path || open.startsWith(`${path}/`))) set({ openFile: null }) // it (or its dir) is gone
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
