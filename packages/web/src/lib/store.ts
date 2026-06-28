// store.ts — the web app's single source of UI state (zustand).
// It owns connection + projects + transcript + shell state, the WireEvent handler, and the actions the
// UI calls. The WebSocket transport is injected once (setSend) by App. Settings/permissions/MCP are
// session/wrapper concerns and deliberately NOT kept here — only pure UI state lives in the store.

import { create } from 'zustand'
import type { WireEvent, WireMessage } from './wsClient'
import { extractMessage, type Item, type Page, type PreviewState, type Recovering, type RightTab, type Streaming } from './types'
import { StreamingOptimizer } from './streamingOptimizer'
import { applyTheme, getInitialTheme, type Theme } from './theme'
import type { FileNode, ProjectInfo, TemplateInfo } from '@cascade/app-protocol'

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
  // code pane (M4) + diff view (M2)
  fileTree: FileNode[]
  openFile: { path: string; content: string } | null
  fileDiff: { path: string; original: string; modified: string } | null
  codeView: 'code' | 'diff'
  // live preview (M3)
  preview: PreviewState | null
  // shell
  sidebarCollapsed: boolean
  rightTab: RightTab
  theme: Theme
  // transport (injected by App)
  send: (m: WireMessage) => void
  setSend: (send: (m: WireMessage) => void) => void
  // actions
  setConnected: (b: boolean) => void
  handleEvent: (e: WireEvent) => void
  submit: (text: string) => void
  stop: () => void
  createProject: (name: string, templateId?: string) => void
  openProject: (id: string) => void
  deleteProject: (id: string) => void
  navigate: (page: Page) => void
  openProjectPage: (id: string) => void
  initRouter: () => void // wire the address bar ↔ store (called once by App)
  startBuild: (prompt: string, templateId?: string) => void
  toggleSidebar: () => void
  setRightTab: (t: RightTab) => void
  toggleTheme: () => void
  requestFile: (path: string) => void
  openFileInCode: (path: string, view?: 'code' | 'diff') => void
  setCodeView: (v: 'code' | 'diff') => void
  startPreview: () => void
  stopPreview: () => void
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
    fileTree: [],
    openFile: null,
    fileDiff: null,
    codeView: 'code',
    preview: null,
    sidebarCollapsed: false,
    rightTab: 'preview',
    theme: getInitialTheme(),
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
        case 'fileDiff':
          set({ fileDiff: { path: e.path, original: e.original, modified: e.modified } })
          break
        case 'preview':
          set({ preview: { status: e.status, url: e.url } })
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
    createProject: (name, templateId) => {
      const n = name.trim()
      if (n) get().send({ type: 'project', action: 'create', name: n, templateId })
    },
    openProject: (id) => {
      if (id === get().activeId) return
      // Set activeId optimistically so submit() works before the server's `projects` snapshot round-trips.
      set({ activeId: id, items: [], streaming: null, status: null, busy: false, fileTree: [], openFile: null, fileDiff: null, codeView: 'code', preview: null })
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
    startPreview: () => {
      set({ preview: { status: 'installing' } }) // optimistic; server confirms via `preview` events
      get().send({ type: 'preview', action: 'start' })
    },
    stopPreview: () => {
      get().send({ type: 'preview', action: 'stop' })
      set({ preview: null })
    },
    toggleTheme: () => {
      const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
      applyTheme(theme)
      set({ theme })
    },
  }
})
