import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import type { Message } from '@cascade/core'
import type { ProjectInfo } from '@cascade/app-protocol'
import { WsClient, type WireEvent } from './wsClient'

const WS_URL = `ws://${location.hostname}:4319`

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; thinking?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; preview?: string }
  | { kind: 'memory'; text: string }
  | { kind: 'compacted'; text: string }

function extract(m: Message): { text: string; thinking: string } {
  if (typeof m.content === 'string') return { text: m.content, thinking: '' }
  let text = ''
  let thinking = ''
  for (const b of m.content) {
    if (b.type === 'text') text += b.text
    else if (b.type === 'thinking') thinking += b.thinking
  }
  return { text, thinking }
}
const toolIcon = (s: 'running' | 'ok' | 'error') => (s === 'running' ? '⏳' : s === 'ok' ? '✓' : '✗')

export function App() {
  const [connected, setConnected] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const [streaming, setStreaming] = useState<{ text: string; thinking: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [recovering, setRecovering] = useState<{ attempt: number; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const clientRef = useRef<WsClient | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const client = new WsClient(WS_URL, onEvent, setConnected)
    client.connect()
    clientRef.current = client
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streaming, status, recovering])

  function onEvent(e: WireEvent) {
    switch (e.type) {
      case 'status':
        setStatus(e.text)
        setRecovering(null)
        break
      case 'recovering':
        setStreaming(null)
        setStatus(null)
        setRecovering({ attempt: e.attempt, reason: e.reason })
        break
      case 'thinking_delta':
        setRecovering(null)
        setStreaming((s) => ({ text: s?.text ?? '', thinking: (s?.thinking ?? '') + e.thinking }))
        break
      case 'text_delta':
        setRecovering(null)
        setStreaming((s) => ({ text: (s?.text ?? '') + e.text, thinking: s?.thinking ?? '' }))
        break
      case 'toolStart':
        setStreaming(null)
        setRecovering(null)
        setItems((it) => [...it, { kind: 'tool', id: e.id, name: e.name, summary: e.summary, status: 'running' }])
        break
      case 'toolProgress':
        setItems((it) => it.map((x) => (x.kind === 'tool' && x.id === e.id ? { ...x, preview: `${x.preview ?? ''}${e.chunk}`.slice(-4000) } : x)))
        break
      case 'toolResult':
        setItems((it) => it.map((x) => (x.kind === 'tool' && x.id === e.id ? { ...x, status: e.ok ? 'ok' : 'error', preview: e.preview } : x)))
        break
      case 'message': {
        const { text, thinking } = extract(e.message)
        setItems((it) => [...it, { kind: 'assistant', text, thinking: thinking || undefined }])
        setStreaming(null)
        break
      }
      case 'memory':
        setItems((it) => [...it, { kind: 'memory', text: e.text }])
        break
      case 'compacted':
        setItems((it) => [...it, { kind: 'compacted', text: e.kind === 'summarized' ? 'summarized older turns' : 'masked old tool output' }])
        break
      case 'turnDone':
        setStatus(null)
        setRecovering(null)
        setBusy(false)
        break
      case 'projects':
        setProjects(e.projects)
        setActiveId(e.activeId ?? null)
        break
    }
  }

  function createProject() {
    const name = newName.trim()
    if (!name) return
    clientRef.current?.send({ type: 'project', action: 'create', name })
    setNewName('')
    setCreating(false)
  }
  function openProject(id: string) {
    if (id === activeId) return
    setItems([]) // fresh view; server-side history persists (transcript replay is a later phase)
    setStreaming(null)
    setStatus(null)
    setBusy(false)
    clientRef.current?.send({ type: 'project', action: 'open', id })
  }
  function deleteProject(id: string) {
    clientRef.current?.send({ type: 'project', action: 'delete', id })
    if (id === activeId) setItems([])
  }

  function send() {
    const text = input.trim()
    if (!text || !connected || !activeId) return
    setItems((it) => [...it, { kind: 'user', text }])
    setInput('')
    setBusy(true)
    clientRef.current?.send({ type: 'submit', text })
  }
  function stop() {
    clientRef.current?.send({ type: 'abort' })
    setBusy(false)
    setStatus(null)
  }

  const activeName = projects.find((p) => p.id === activeId)?.name

  return (
    <div className="flex h-screen bg-neutral-900 text-neutral-100 text-sm">
      {/* ── Project sidebar (13.2): each project = its own workspace + dedicated session ── */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Projects</span>
          <button className="ml-auto rounded px-1.5 text-lg leading-none text-neutral-400 hover:text-neutral-100" title="New project" onClick={() => setCreating((c) => !c)}>＋</button>
        </div>
        {creating && (
          <div className="border-b border-neutral-800 p-2">
            <input
              autoFocus
              className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
              placeholder="project name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createProject()
                if (e.key === 'Escape') (setCreating(false), setNewName(''))
              }}
            />
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-1">
          {projects.length === 0 && <div className="px-2 py-3 text-xs text-neutral-600">No projects yet.</div>}
          {projects.map((p) => (
            <div
              key={p.id}
              className={`group flex cursor-pointer items-center gap-1 rounded px-2 py-1.5 ${p.id === activeId ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'}`}
              onClick={() => openProject(p.id)}
            >
              <span className="truncate">{p.id === activeId ? '📂' : '📁'} {p.name}</span>
              <button
                className="ml-auto hidden text-neutral-600 hover:text-red-400 group-hover:block"
                title="Delete project"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteProject(p.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main column: header + transcript + composer (or an empty state) ── */}
      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
          <span className="font-semibold tracking-wide">Cascade</span>
          {activeName && <span className="text-neutral-500">/ {activeName}</span>}
          <span className={`ml-auto inline-flex items-center gap-1.5 text-xs ${connected ? 'text-green-400' : 'text-neutral-500'}`}>
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-neutral-600'}`} />
            {connected ? 'connected' : 'connecting…'}
          </span>
        </header>

        {!activeId ? (
          <div className="flex flex-1 items-center justify-center text-center text-neutral-500">
            <div>
              <div className="text-3xl">📂</div>
              <p className="mt-2 text-sm">Select a project, or create one to start building.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3">
        {items.map((it, i) =>
          it.kind === 'memory' ? (
            <div key={i} className="my-1 border-l-2 border-purple-500/60 px-2 text-xs italic text-neutral-400">💾 Remembered: {it.text}</div>
          ) : it.kind === 'compacted' ? (
            <div key={i} className="my-2 border-y border-dashed border-neutral-700 py-1 text-center text-xs italic text-neutral-400">🗜 Context compacted — {it.text}</div>
          ) : it.kind === 'tool' ? (
            <div key={i} className="my-1.5 overflow-hidden rounded-md border border-neutral-700 bg-neutral-800/60">
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span>{it.status === 'running' ? '⏳' : toolIcon(it.status)}</span>
                <span className="font-mono font-semibold">{it.name}</span>
                <span className="text-neutral-400">{it.summary}</span>
              </div>
              {it.preview && <pre className="max-h-32 overflow-auto border-t border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-400 whitespace-pre-wrap">{it.preview}</pre>}
            </div>
          ) : (
            <div key={i} className={`my-2 rounded-lg px-3 py-2 ${it.kind === 'user' ? 'bg-neutral-800' : 'bg-neutral-800/40'}`}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{it.kind}</div>
              {it.kind === 'assistant' && it.thinking && (
                <details className="mb-1 text-xs text-neutral-400">
                  <summary className="cursor-pointer select-none">💭 Thinking</summary>
                  <div className="mt-1 border-l-2 border-neutral-700 pl-2 whitespace-pre-wrap">{it.thinking}</div>
                </details>
              )}
              {it.kind === 'assistant' ? <div className="prose prose-invert prose-sm max-w-none"><Streamdown>{it.text}</Streamdown></div> : <div className="whitespace-pre-wrap">{it.text}</div>}
            </div>
          ),
        )}
        {streaming && (
          <div className="my-2 rounded-lg bg-neutral-800/40 px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">assistant</div>
            <div className="prose prose-invert prose-sm max-w-none"><Streamdown>{streaming.text}</Streamdown></div>
          </div>
        )}
        {recovering && (
          <div className="my-2 flex items-center gap-2 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
            <span className="animate-spin">⟳</span>
            {recovering.reason === 'overflow' ? 'Context too large — compacting and retrying…' : "Can't reach the model — reconnecting…"} <span className="opacity-60">attempt {recovering.attempt}</span>
          </div>
        )}
        {status && !streaming && !recovering && <div className="px-2 py-1.5 text-xs italic text-neutral-500">⏳ {status}</div>}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2 border-t border-neutral-800 p-3">
        <textarea
          className="flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
          rows={2}
          placeholder={connected ? 'Ask Cascade…' : 'connecting to server…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
              {busy ? (
                <button className="rounded-md bg-red-600 px-4 font-medium text-white" onClick={stop}>■ Stop</button>
              ) : (
                <button className="rounded-md bg-blue-600 px-4 font-medium text-white disabled:opacity-40" onClick={send} disabled={!connected}>Send</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
