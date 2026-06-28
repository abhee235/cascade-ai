// store.ts — the web app's single source of UI state (zustand).
// It owns connection + projects + transcript + shell state, the WireEvent handler, and the actions the
// UI calls. The WebSocket transport is injected once (setSend) by App. Settings/permissions/MCP are
// session/wrapper concerns and deliberately NOT kept here — only pure UI state lives in the store.

import { create } from 'zustand'
import type { WireEvent, WireMessage } from './wsClient'
import { extractMessage, type Item, type PreviewState, type Recovering, type RightTab, type Streaming } from './types'
import { StreamingOptimizer } from './streamingOptimizer'
import { applyTheme, getInitialTheme, type Theme } from './theme'
import type { FileNode, ProjectInfo, TemplateInfo } from '@cascade/app-protocol'

interface UiState {
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

  return {
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
          set((s) => ({ items: [...s.items, { kind: 'assistant', text, thinking: thinking || undefined }], streaming: null }))
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
          set({ status: null, recovering: null, busy: false })
          break
        // ── app/builder events (BuilderEvent) ──
        case 'projects':
          set({ projects: e.projects, activeId: e.activeId ?? null })
          break
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
      set({ items: [], streaming: null, status: null, busy: false, fileTree: [], openFile: null, fileDiff: null, codeView: 'code', preview: null })
      get().send({ type: 'project', action: 'open', id })
    },
    deleteProject: (id) => {
      get().send({ type: 'project', action: 'delete', id })
      if (id === get().activeId) set({ items: [] })
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
