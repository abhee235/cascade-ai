import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { mermaid } from '@streamdown/mermaid'
import { createMathPlugin } from '@streamdown/math'
import { createCodePlugin } from '@streamdown/code'
import type { ActivityEvent, Answers, Message, Question, ToolDisplay } from '@cascade/core'

// VS Code injects this into the webview global scope.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }
const vscode = acquireVsCodeApi()

// Shiki dual [light,dark] theme switches via a `.dark` class — unreliable in the webview, so detect
// VS Code's theme once and pin BOTH slots to the matching Shiki theme (guarantees contrast).
const codeTheme = document.body.classList.contains('vscode-light') ? 'github-light' : 'github-dark'

const mdPlugins = {
  mermaid,
  math: createMathPlugin({ singleDollarTextMath: true }),
  code: createCodePlugin({ themes: [codeTheme, codeTheme] }),
}

// Convert LaTeX delimiters \[ \] / \( \) → $$ / $ (remark-math only knows $), outside code spans.
function normalizeMath(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .replace(/\\\[([\s\S]*?)\\\]/g, (_m, x) => `$$${x}$$`)
            .replace(/\\\(([\s\S]*?)\\\)/g, (_m, x) => `$${x}$`),
    )
    .join('')
}
function Md({ children }: { children: string }) {
  return <Streamdown plugins={mdPlugins}>{normalizeMath(children)}</Streamdown>
}

/** Inline unified-diff for a file edit (shown right in the panel). */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <div style={styles.diffBlock}>
      {diff.split('\n').map((line, i) => {
        const c = line[0]
        const style = c === '+' ? styles.diffAdd : c === '-' ? styles.diffDel : styles.diffCtx
        return (
          <div key={i} style={style}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }

/** The agent's task checklist (TodoWrite). Status glyphs: ✓ completed (struck through), a
 *  spinner while in_progress (shows the activeForm), dimmed ○ pending. */
function TodoList({ items }: { items: Todo[] }) {
  const done = items.filter((t) => t.status === 'completed').length
  return (
    <div style={styles.todoCard}>
      <div style={styles.todoHeader}>
        <span>☑</span>
        <span style={styles.toolName}>Tasks</span>
        <span style={styles.todoCount}>
          {done}/{items.length}
        </span>
      </div>
      <div style={styles.todoBody}>
        {items.map((t, i) => (
          <div key={i} style={styles.todoRow}>
            {t.status === 'completed' ? (
              <span style={styles.todoDone}>✓</span>
            ) : t.status === 'in_progress' ? (
              <span className="cascade-spinner" />
            ) : (
              <span style={styles.todoPending}>○</span>
            )}
            <span
              style={{
                opacity: t.status === 'completed' ? 0.55 : 1,
                textDecoration: t.status === 'completed' ? 'line-through' : 'none',
                fontWeight: t.status === 'in_progress' ? 600 : 400,
              }}
            >
              {t.status === 'in_progress' ? t.activeForm : t.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Transcript items: user/assistant messages and tool cards, interleaved in order.
type Item =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string; thinking?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; preview?: string; display?: ToolDisplay }
  | { kind: 'memory'; text: string }
  | { kind: 'compacted'; text: string }
  | { kind: 'question'; questions: Question[]; answered: Answers } // ADR-043: an answered AskUserQuestion (read-only record)

/** The ACTIVE AskUserQuestion (ADR-043) — the loop is PARKED until the user submits, so this card is the
 *  resume button. Single- or multi-select per question, plus an always-present "Other" free-text (the model
 *  is told not to add its own Other option). Mirrors the web app's QuestionCard. */
function QuestionCard({ questions, onSubmit }: { questions: Question[]; onSubmit: (answers: Answers) => void }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({}) // question index → selected labels
  const [other, setOther] = useState<Record<number, string>>({}) // question index → "Other" free text

  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicked((s) => {
      const cur = s[qi] ?? []
      if (multi) return { ...s, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      return { ...s, [qi]: [label] }
    })

  const canSubmit = questions.every((_q, qi) => (picked[qi]?.length ?? 0) > 0 || (other[qi] ?? '').trim().length > 0)

  const submit = () => {
    const answers: Answers = {}
    questions.forEach((q, qi) => {
      const labels = [...(picked[qi] ?? [])]
      const o = (other[qi] ?? '').trim()
      if (o) labels.push(o)
      answers[q.question] = labels.join(', ')
    })
    onSubmit(answers)
  }

  return (
    <div style={styles.qCard}>
      <div style={styles.qTitle}>❔ Cascade needs your input</div>
      {questions.map((q, qi) => {
        const multi = !!q.multiSelect
        const sel = picked[qi] ?? []
        return (
          <div key={qi} style={qi > 0 ? styles.qDivider : undefined}>
            <span style={styles.qChip}>{q.header}</span>
            <div style={styles.qQuestion}>{q.question}</div>
            <div style={styles.qOptions}>
              {q.options.map((o) => {
                const on = sel.includes(o.label)
                return (
                  <button
                    key={o.label}
                    style={{ ...styles.qOpt, ...(on ? styles.qOptOn : undefined) }}
                    onClick={() => toggle(qi, o.label, multi)}
                  >
                    <span style={{ ...styles.qBox, borderRadius: multi ? 3 : '50%', ...(on ? styles.qBoxOn : undefined) }}>
                      {on ? '✓' : ''}
                    </span>
                    <span>
                      <span style={styles.qOptLabel}>{o.label}</span>
                      {o.description && <span style={styles.qOptDesc}>{o.description}</span>}
                    </span>
                  </button>
                )
              })}
              <input
                style={styles.qOther}
                type="text"
                placeholder="Other… (type your own)"
                value={other[qi] ?? ''}
                onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))}
              />
            </div>
          </div>
        )
      })}
      <button
        style={{ ...styles.qSubmit, ...(canSubmit ? undefined : styles.qSubmitOff) }}
        disabled={!canSubmit}
        onClick={submit}
      >
        Submit answer
      </button>
    </div>
  )
}

// Label for the `compacted` event's layer kind (ADR-039). Mirrors core's compactionKindLabel; inlined so the
// webview bundle doesn't pull in the node-side @cascade/core runtime just for a string.
function compactedLabel(kind: string): string {
  switch (kind) {
    case 'collapsed': return 'collapsed superseded reads/searches'
    case 'masked': return 'masked large old tool output'
    case 'microcompacted': return 'cleared old tool results'
    case 'snipped': return 'snipped large tool inputs'
    case 'summarized': return 'summarized older turns'
    case 'dropped': return 'dropped older turns (summarizer unavailable; task preserved)'
    default: return 'compacted context'
  }
}

function extract(message: Message): { text: string; thinking: string } {
  if (typeof message.content === 'string') return { text: message.content, thinking: '' }
  let text = ''
  let thinking = ''
  for (const b of message.content) {
    if (b.type === 'text') text += b.text
    else if (b.type === 'thinking') thinking += b.thinking
  }
  return { text, thinking }
}

const toolIcon = (s: 'running' | 'ok' | 'error') => (s === 'running' ? '⏳' : s === 'ok' ? '✓' : '✗')
const COMMANDS = [
  { cmd: '/mcp', desc: 'Manage MCP servers' },
  { cmd: '/memory', desc: 'View & manage memory (core + archival)' },
  { cmd: '/models', desc: 'Model manager — provider, model, sampling, context window' },
]

// Model manager payloads (host mirrors: postModels / setModelConfig).
type ModelSettings = {
  provider: string
  model: string
  baseUrl: string
  apiKeySet: boolean
  utilityModel: string
  permissionMode: string
  contextWindow: number
  maxOutputTokens: number
  temperature: number
  topP: number
  topK: number
}
type EnabledModel = { provider: string; model: string; contextWindow?: number }
type ModelsData = {
  settings: ModelSettings
  /** The CURATED enabled models (ADR-067) — spans providers; this is what the dropdown lists. */
  enabled: EnabledModel[]
  info?: { capabilities: string[]; contextWindow?: number; archMax?: number }
  error?: string
}

// Extension-local host events (chat persistence + user-invocable skills) riding the same postMessage
// channel as core ActivityEvents — mirrors the host's HostMessage union.
type ChatMeta = { id: string; title: string; updatedAt: string }
type HostEvent =
  | ActivityEvent
  | { type: 'chatsData'; chats: ChatMeta[]; activeId: string }
  | { type: 'chatRestored'; items: Item[] }
  | { type: 'skillsData'; skills: { name: string; description: string }[] }
  | ({ type: 'modelsData' } & ModelsData)
  | { type: 'hostInfo'; build: string }

// Baked in by esbuild `define` — this webview bundle's build time (compared against the host's).
declare const __CASCADE_BUILD__: string
const mcpIcon = (s: string) => (s === 'ready' ? '●' : s === 'connecting' ? '◌' : s === 'failed' ? '✗' : '○')
const mcpColor = (s: string) =>
  s === 'ready'
    ? 'var(--vscode-testing-iconPassed, #3a3)'
    : s === 'connecting'
      ? 'var(--vscode-charts-yellow, #cc3)'
      : s === 'failed'
        ? 'var(--vscode-errorForeground, #c33)'
        : 'var(--vscode-disabledForeground, #888)'

export function App() {
  const [items, setItems] = useState<Item[]>([])
  const [streaming, setStreaming] = useState<{ text: string; thinking: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [recovering, setRecovering] = useState<{ attempt: number; reason: string } | null>(null)
  const [prompt, setPrompt] = useState<{ id: string; tool: string; detail: string } | null>(null)
  const [question, setQuestion] = useState<{ id: string; questions: Question[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [mcp, setMcp] = useState<{ name: string; status: string; error?: string; toolNames: string[] }[] | null>(null)
  const [mem, setMem] = useState<{ core: string; archival: { id: string; text: string; ts: string }[]; hits?: { text: string; score: number }[] } | null>(null)
  const [memQuery, setMemQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [input, setInput] = useState('')
  // ADR-039: live context occupancy after each model call — how full the window is RIGHT NOW, and the
  // threshold compaction fires at. Persists between turns (it describes the session, not one turn).
  const [ctx, setCtx] = useState<{ used: number; window: number; auto: number } | null>(null)
  // Images attached to the NEXT submit (pasted into the composer), as data URIs. M11 multimodal turns.
  const [attached, setAttached] = useState<string[]>([])
  // Chat persistence + user-invocable skills (host-local protocol).
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [skillCmds, setSkillCmds] = useState<{ name: string; description: string }[]>([])
  // Model snapshot for the composer chip + dropdown (the Language Models panel lives in the editor area).
  const [modelData, setModelData] = useState<ModelsData | null>(null)
  const [modelMenu, setModelMenu] = useState(false)
  const [modeMenu, setModeMenu] = useState(false)
  // Stale-host detection: set from the host's hostInfo handshake; mismatch = restart needed. The
  // "no response" verdict waits out a grace period so a slow activation never flashes a false banner.
  const [hostBuild, setHostBuild] = useState<string | null>(null)
  const [handshakeTimedOut, setHandshakeTimedOut] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  // On mount: handshake first (the listener above is attached, so the reply cannot be dropped), then
  // restore the active chat, fetch skills for the / menu, and the model snapshot (composer chip).
  useEffect(() => {
    vscode.postMessage({ type: 'hello' })
    vscode.postMessage({ type: 'chats' })
    vscode.postMessage({ type: 'skills' })
    vscode.postMessage({ type: 'models' })
    const t = setTimeout(() => setHandshakeTimedOut(true), 4000)
    return () => clearTimeout(t)
  }, [])

  // Poll for live status while any server is still connecting (so the overlay updates without a manual Refresh).
  const polling = !!mcp && mcp.some((s) => s.status === 'connecting')
  useEffect(() => {
    if (!polling) return
    const id = setInterval(() => vscode.postMessage({ type: 'mcp', action: 'list' }), 1000)
    return () => clearInterval(id)
  }, [polling])

  // Esc closes whichever overlay is open.
  useEffect(() => {
    if (!mcp && !mem) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMcp(null)
        setMem(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mcp, mem])

  useEffect(() => {
    function onMessage(e: MessageEvent<HostEvent>) {
      const event = e.data
      switch (event.type) {
        case 'chatsData':
          setChats(event.chats)
          setActiveChatId(event.activeId)
          break
        case 'chatRestored':
          // A restored transcript replaces the local one wholesale (mount, chat switch, new chat).
          setItems(event.items)
          setStreaming(null)
          setStatus(null)
          setRecovering(null)
          break
        case 'skillsData':
          setSkillCmds(event.skills)
          break
        case 'modelsData':
          setModelData({ settings: event.settings, enabled: event.enabled ?? [], info: event.info, error: event.error })
          break
        case 'hostInfo':
          setHostBuild(event.build)
          break
        case 'status':
          setStatus(event.text)
          setRecovering(null) // a new "Thinking…" means we're past the retry
          break
        case 'recovering':
          // The model call failed and we're retrying — show a persistent card (clears on the next progress).
          setStreaming(null)
          setStatus(null)
          setRecovering({ attempt: event.attempt, reason: event.reason })
          break
        case 'thinking_delta':
          setRecovering(null)
          setStreaming((s) => ({ text: s?.text ?? '', thinking: (s?.thinking ?? '') + event.thinking }))
          break
        case 'text_delta':
          setRecovering(null)
          setStreaming((s) => ({ text: (s?.text ?? '') + event.text, thinking: s?.thinking ?? '' }))
          break
        case 'permission':
          // A write needs approval. The core loop is now PARKED awaiting respondPermission(id, …).
          setStatus(null)
          setPrompt({ id: event.id, tool: event.tool, detail: event.detail })
          break
        case 'question':
          // The agent asked the user (ADR-043). The core loop is now PARKED awaiting respondQuestion(id, …).
          setStatus(null)
          setStreaming(null)
          setQuestion({ id: event.id, questions: event.questions })
          break
        case 'toolStart':
          // A tool is running — drop any transient pre-tool text and add a card.
          setStreaming(null)
          setRecovering(null)
          setItems((it) => [...it, { kind: 'tool', id: event.id, name: event.name, summary: event.summary, status: 'running' }])
          break
        case 'toolProgress':
          // Live output from a running tool (e.g. Bash stdout). Append into its card, capped so the DOM
          // stays sane; keep the TAIL (most recent output is what you're watching).
          setItems((it) =>
            it.map((x) =>
              x.kind === 'tool' && x.id === event.id
                ? { ...x, preview: `${x.preview ?? ''}${event.chunk}`.slice(-4000) }
                : x,
            ),
          )
          break
        case 'toolResult':
          setItems((it) =>
            it.map((x) =>
              x.kind === 'tool' && x.id === event.id
                ? { ...x, status: event.ok ? 'ok' : 'error', preview: event.preview, display: event.display }
                : x,
            ),
          )
          break
        case 'message': {
          const { text, thinking } = extract(event.message)
          setItems((it) => [...it, { kind: 'assistant', text, thinking: thinking || undefined }])
          setStreaming(null)
          break
        }
        case 'turnDone':
          setStatus(null)
          setRecovering(null)
          setBusy(false)
          break
        case 'memory':
          // Self-curation saved a durable fact — show a subtle marker so it's transparent.
          setItems((it) => [...it, { kind: 'memory', text: event.text }])
          break
        case 'compacted':
          setItems((it) => [
            ...it,
            { kind: 'compacted', text: compactedLabel(event.kind) },
          ])
          break
        case 'context':
          // Live occupancy for the meter above the composer.
          setCtx({ used: event.used, window: event.window, auto: event.auto })
          break
        case 'step':
          // Prefill is starting — the dead-air phase on local models. Show SOMETHING until the first
          // delta, but never overwrite a real status (and only turnDone clears the working state).
          setStatus((s) => s ?? 'Reading context…')
          break
        case 'mcpStatus':
          setMcp(event.servers)
          break
        case 'memoryData':
          setMem({ core: event.core, archival: event.archival, hits: event.hits })
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streaming, status])

  // Slash commands (a `/` menu): builtins + every loaded SKILL (user-invocable as
  // /<skill-name>). Skills take arguments after the name, so selecting one inserts
  // "/name " for the user to finish, while builtins run immediately.
  const allCommands = [
    ...COMMANDS.map((c) => ({ ...c, kind: 'builtin' as const })),
    ...skillCmds.map((s) => ({ cmd: `/${s.name}`, desc: s.description, kind: 'skill' as const })),
  ]
  const slashToken = input.startsWith('/') ? input.trim().split(/\s+/)[0] : ''
  const slashMatches = slashToken && !input.trim().includes(' ') ? allCommands.filter((c) => c.cmd.startsWith(slashToken)) : []

  function runCommand(cmd: string) {
    setInput('')
    if (cmd === '/mcp') vscode.postMessage({ type: 'mcp', action: 'list' }) // opens the overlay (mcpStatus reply)
    if (cmd === '/memory') vscode.postMessage({ type: 'memoryView', action: 'list' }) // opens the memory overlay
    if (cmd === '/models') vscode.postMessage({ type: 'openModelsPanel' }) // the Language Models editor tab
  }

  function pickSlash(c: (typeof allCommands)[number]) {
    if (c.kind === 'builtin') return runCommand(c.cmd)
    setInput(`${c.cmd} `) // skill: let the user type arguments, Enter sends
  }

  function memAction(action: 'list' | 'search' | 'forget', extra?: { query?: string; id?: string }) {
    vscode.postMessage({ type: 'memoryView', action, query: extra?.query, id: extra?.id })
  }

  function send() {
    const text = input.trim()
    if (!text && attached.length === 0) return
    if (text.startsWith('/')) {
      const token = text.split(/\s+/)[0]
      const args = text.slice(token.length).trim()
      // Exact builtin runs; exact skill submits the playbook turn with any trailing arguments.
      const exact = allCommands.find((c) => c.cmd === token)
      if (exact?.kind === 'builtin') return runCommand(exact.cmd)
      if (exact?.kind === 'skill') {
        setItems((it) => [...it, { kind: 'user', text }]) // show "/name args" as the user's turn
        setInput('')
        setBusy(true)
        vscode.postMessage({ type: 'runSkill', name: exact.cmd.slice(1), args: args || undefined })
        return
      }
      if (slashMatches.length === 1) return pickSlash(slashMatches[0])
      return // unknown/ambiguous slash input — do nothing (the menu is showing options)
    }
    const images = attached.length ? attached : undefined
    setItems((it) => [...it, { kind: 'user', text, images }])
    setInput('')
    setAttached([])
    setBusy(true)
    vscode.postMessage({ type: 'submit', text, images })
  }

  const fileRef = useRef<HTMLInputElement>(null)
  /** The [+] button: pick image files → attach to the next turn (same path as paste). */
  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    for (const file of Array.from(e.target.files ?? [])) {
      const reader = new FileReader()
      reader.onload = () => setAttached((a) => [...a, String(reader.result)])
      reader.readAsDataURL(file)
    }
    e.target.value = '' // same file can be picked again later
  }

  /** Paste an image into the composer → attach it to the next turn (vision models). */
  function onPaste(e: React.ClipboardEvent) {
    const imgs = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'))
    if (imgs.length === 0) return
    e.preventDefault()
    for (const item of imgs) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => setAttached((a) => [...a, String(reader.result)])
      reader.readAsDataURL(file)
    }
  }

  function mcpAction(action: 'list' | 'connect' | 'disconnect', server?: string) {
    vscode.postMessage({ type: 'mcp', action, server })
  }

  function toggleTools(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  function stop() {
    vscode.postMessage({ type: 'abort' })
    setBusy(false)
    setStatus(null)
    setQuestion(null) // abort() resolves a parked question with no answers — drop the card
  }

  function respond(decision: 'allow' | 'allow-always' | 'deny') {
    if (!prompt) return
    vscode.postMessage({ type: 'permission', id: prompt.id, decision })
    setPrompt(null) // optimistic; the core resumes and the tool card will follow
  }

  function answer(answers: Answers) {
    if (!question) return
    vscode.postMessage({ type: 'answer', id: question.id, answers })
    // Keep a read-only record in the transcript (like the web app) so the conversation stays coherent.
    setItems((it) => [...it, { kind: 'question', questions: question.questions, answered: answers }])
    setQuestion(null) // the core loop resumes with the answers
  }

  function newChat() {
    setItems([])
    setStreaming(null)
    setStatus(null)
    setPrompt(null)
    setQuestion(null)
    setBusy(false)
    setCtx(null) // a fresh conversation has no occupancy yet
    setAttached([])
    vscode.postMessage({ type: 'reset' })
  }

  return (
    <div style={styles.app}>
      {mcp && (
        <div style={styles.backdrop} onClick={() => setMcp(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHead}>
              <span style={styles.modalTitle}>MCP servers</span>
              <span style={styles.modalSub}>{polling ? 'refreshing…' : `${mcp.length} configured`}</span>
              <button style={styles.iconBtn} onClick={() => setMcp(null)} title="Close (Esc)">
                ✕
              </button>
            </div>
            <div style={styles.modalBody}>
              {mcp.length === 0 && (
                <div style={styles.mcpEmpty}>
                  No MCP servers configured. Add them to <code>.mcp.json</code> at the project root:
                  <pre style={styles.codeBlock}>{'{\n  "mcpServers": {\n    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }\n  }\n}'}</pre>
                </div>
              )}
              {mcp.map((s) => (
                <div key={s.name} style={styles.serverCard}>
                  <div style={styles.serverTop}>
                    {s.status === 'connecting' ? (
                      <span className="cascade-spinner" />
                    ) : (
                      <span style={{ ...styles.statusDot, color: mcpColor(s.status) }}>{mcpIcon(s.status)}</span>
                    )}
                    <span style={styles.serverName}>{s.name}</span>
                    <span style={{ ...styles.statusLabel, color: mcpColor(s.status) }}>{s.status}</span>
                    <span style={styles.spacer} />
                    {s.status === 'ready' && (
                      <button style={styles.linkBtn} onClick={() => toggleTools(s.name)}>
                        {s.toolNames.length} tools {expanded.has(s.name) ? '▾' : '▸'}
                      </button>
                    )}
                    {s.status === 'ready' || s.status === 'connecting' ? (
                      <button style={styles.cardBtn} onClick={() => mcpAction('disconnect', s.name)}>
                        Disconnect
                      </button>
                    ) : (
                      <button style={{ ...styles.cardBtn, ...styles.cardBtnPrimary }} onClick={() => mcpAction('connect', s.name)}>
                        {s.status === 'failed' ? 'Retry' : 'Connect'}
                      </button>
                    )}
                  </div>
                  {s.error && <div style={styles.serverError}>⚠ {s.error}</div>}
                  {s.status === 'ready' && expanded.has(s.name) && (
                    <div style={styles.toolList}>
                      {s.toolNames.length === 0 ? (
                        <span style={styles.mcpMeta}>(server exposes no tools)</span>
                      ) : (
                        s.toolNames.map((t) => (
                          <code key={t} style={styles.toolChip}>
                            {t}
                          </code>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={styles.modalFoot}>
              <span style={styles.mcpMeta}>Configured in .mcp.json</span>
              <button style={styles.cardBtn} onClick={() => mcpAction('list')}>
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}
      {mem && (
        <div style={styles.backdrop} onClick={() => setMem(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHead}>
              <span style={styles.modalTitle}>Memory</span>
              <span style={styles.modalSub}>{mem.archival.length} archival</span>
              <button style={styles.iconBtn} onClick={() => setMem(null)} title="Close (Esc)">
                ✕
              </button>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.memSection}>Core memory (always in context)</div>
              <pre style={styles.codeBlock}>{mem.core ? mem.core : '(empty — nothing saved to CASCADE.md yet)'}</pre>

              <div style={styles.memSearchRow}>
                <input
                  style={styles.memSearchInput}
                  value={memQuery}
                  placeholder="Semantic search archival memory…"
                  onChange={(e) => setMemQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && memAction('search', { query: memQuery })}
                />
                <button style={styles.cardBtn} onClick={() => memAction('search', { query: memQuery })}>
                  Search
                </button>
              </div>

              {mem.hits && (
                <div style={styles.memSection}>
                  Top matches{' '}
                  <button style={styles.linkBtn} onClick={() => memAction('list')}>
                    clear
                  </button>
                </div>
              )}
              {mem.hits?.map((h, i) => (
                <div key={`h${i}`} style={styles.memRow}>
                  <span style={styles.memScore}>{h.score.toFixed(2)}</span>
                  <span style={styles.memText}>{h.text}</span>
                </div>
              ))}

              {!mem.hits && <div style={styles.memSection}>Archival memory (searched on demand)</div>}
              {!mem.hits &&
                (mem.archival.length === 0 ? (
                  <div style={styles.mcpEmpty}>Nothing archived yet. The agent saves detailed facts here automatically.</div>
                ) : (
                  mem.archival.map((e) => (
                    <div key={e.id} style={styles.memRow}>
                      <span style={styles.memText}>{e.text}</span>
                      <span style={styles.spacer} />
                      <button style={styles.linkBtn} onClick={() => memAction('forget', { id: e.id })}>
                        forget
                      </button>
                    </div>
                  ))
                ))}
            </div>
            <div style={styles.modalFoot}>
              <span style={styles.mcpMeta}>Core = CASCADE.md · Archival = .cascade/archival.json</span>
              <button style={styles.cardBtn} onClick={() => memAction('list')}>
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}
      {(hostBuild !== null ? hostBuild !== __CASCADE_BUILD__ : handshakeTimedOut) && (
        // The invisible failure made visible: either the host never answered the handshake within the
        // grace period (stale host that predates it) or its build differs from this webview bundle's.
        <div style={styles.staleBanner}>
          ⚠ Extension host {hostBuild === null ? 'did not answer the handshake (older build?)' : `build ${hostBuild.slice(11, 19)} ≠ UI build ${__CASCADE_BUILD__.slice(11, 19)}`}.
          Stop the debug session fully (Shift+F5) and press F5 again — a window/panel reload is not enough.
        </div>
      )}
      <div style={styles.header}>
        <span style={styles.title} title={`UI build ${__CASCADE_BUILD__}${hostBuild ? ` · host build ${hostBuild}` : ''}`}>
          Cascade
        </span>
        {chats.length > 0 && (
          <select
            style={styles.chatPicker}
            value={activeChatId ?? ''}
            disabled={busy}
            onChange={(e) => e.target.value && vscode.postMessage({ type: 'chatSwitch', id: e.target.value })}
            title="Switch chat (history is saved per workspace)"
          >
            {activeChatId && !chats.some((c) => c.id === activeChatId) && <option value={activeChatId}>(new chat)</option>}
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
        <div style={styles.headerRight}>
          {activeChatId && chats.some((c) => c.id === activeChatId) && (
            <button
              style={styles.newChat}
              title="Delete this chat"
              disabled={busy}
              onClick={() => vscode.postMessage({ type: 'chatDelete', id: activeChatId })}
            >
              🗑
            </button>
          )}
          <button style={styles.newChat} onClick={newChat}>
            + New chat
          </button>
        </div>
      </div>
      <div style={styles.transcript}>
        {items.map((it, i) =>
          it.kind === 'memory' ? (
            <div key={i} style={styles.memoryMarker}>
              💾 Remembered: {it.text}
            </div>
          ) : it.kind === 'compacted' ? (
            <div key={i} style={styles.compactMarker}>
              🗜 Context compacted — {it.text}
            </div>
          ) : it.kind === 'question' ? (
            // An answered AskUserQuestion — read-only record of what was asked and chosen.
            <div key={i} style={styles.qAnswered}>
              {it.questions.map((q, qi) => (
                <div key={qi} style={qi > 0 ? { marginTop: 6 } : undefined}>
                  <span style={styles.qChip}>{q.header}</span>
                  <div style={styles.qAnsweredRow}>
                    <span style={styles.qAnsweredCheck}>✓</span>
                    <span>
                      <span style={styles.qAnsweredQ}>{q.question} </span>
                      <span style={styles.qAnsweredA}>{it.answered[q.question] || '—'}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : it.kind === 'tool' && it.display?.kind === 'todos' ? (
            // TodoWrite updates the SAME checklist — render only the latest card (skip superseded ones), so
            // it reads as one live list, not a 0/3 → 1/3 → 2/3 stack.
            i === items.reduce((acc, x, ix) => (x.kind === 'tool' && x.display?.kind === 'todos' ? ix : acc), -1) ? <TodoList key={i} items={it.display.items} /> : null
          ) : it.kind === 'tool' && it.display?.kind === 'fileEdit' ? (
            // File edit → an inline diff (in the extension panel).
            <div key={i} style={styles.toolCard}>
              <div style={styles.toolHeader}>
                <span>{it.display.op === 'create' ? '➕' : '✎'}</span>
                <span style={styles.toolName}>{it.display.path}</span>
                <span style={styles.toolSummary}>
                  {it.display.op === 'create' ? 'created' : it.display.op === 'overwrite' ? 'rewrote' : 'edited'}
                </span>
              </div>
              <DiffBlock diff={it.display.diff} />
            </div>
          ) : it.kind === 'tool' ? (
            <div key={i} style={styles.toolCard}>
              <div style={styles.toolHeader}>
                {it.status === 'running' ? (
                  <span className="cascade-spinner" />
                ) : (
                  <span>{toolIcon(it.status)}</span>
                )}
                <span style={styles.toolName}>{it.name}</span>
                <span style={styles.toolSummary}>{it.summary}</span>
              </div>
              {it.preview && <pre style={styles.toolPreview}>{it.preview}</pre>}
            </div>
          ) : (
            <div key={i} style={{ ...styles.bubble, ...(it.kind === 'user' ? styles.user : styles.assistant) }}>
              <div style={styles.role}>{it.kind}</div>
              {it.kind === 'assistant' && it.thinking && (
                <details style={styles.thinking}>
                  <summary style={styles.thinkingSummary}>💭 Thinking</summary>
                  <div style={styles.thinkingBody} className="cascade-md">
                    <Md>{it.thinking}</Md>
                  </div>
                </details>
              )}
              {it.kind === 'assistant' ? (
                <div className="cascade-md">
                  <Md>{it.text}</Md>
                </div>
              ) : (
                <>
                  {it.images && it.images.length > 0 && (
                    <div style={styles.userImgs}>
                      {it.images.map((u, ix) => (
                        <img key={ix} src={u} style={styles.userImg} alt="attached" />
                      ))}
                    </div>
                  )}
                  <div style={styles.text}>{it.text}</div>
                </>
              )}
            </div>
          ),
        )}
        {streaming && (
          <div style={{ ...styles.bubble, ...styles.assistant }}>
            <div style={styles.role}>assistant</div>
            {streaming.thinking && (
              <details style={styles.thinking} open>
                <summary style={styles.thinkingSummary}>💭 Thinking</summary>
                <div style={styles.thinkingBody} className="cascade-md">
                  <Md>{streaming.thinking}</Md>
                </div>
              </details>
            )}
            <div className="cascade-md">
              <Md>{streaming.text}</Md>
              <span style={styles.caret} className="cascade-caret">▋</span>
            </div>
          </div>
        )}
        {question && <QuestionCard questions={question.questions} onSubmit={answer} />}
        {prompt && (
          <div style={styles.permCard}>
            <div style={styles.permTitle}>Allow Cascade to run this?</div>
            <div style={styles.permDetail}>
              <span style={styles.toolName}>{prompt.tool}</span> — {prompt.detail}
            </div>
            <div style={styles.permButtons}>
              <button style={{ ...styles.permBtn, ...styles.permAllow }} onClick={() => respond('allow')}>
                Allow once
              </button>
              <button style={styles.permBtn} onClick={() => respond('allow-always')}>
                Always allow {prompt.tool}
              </button>
              <button style={{ ...styles.permBtn, ...styles.permDeny }} onClick={() => respond('deny')}>
                Deny
              </button>
            </div>
          </div>
        )}
        {recovering && (
          <div style={styles.recoverCard}>
            <span className="cascade-spinner" />
            <span>
              {recovering.reason === 'overflow'
                ? 'Context too large — compacting and retrying…'
                : `Can't reach ${modelData ? `${modelData.settings.provider} (${modelData.settings.model})` : 'the model backend'} — retrying…`}{' '}
              <span style={styles.recoverAttempt}>attempt {recovering.attempt}</span>
            </span>
          </div>
        )}
        {status && !streaming && !recovering && (
          <div style={styles.status}>
            <span className="cascade-spinner" /> {status}
          </div>
        )}
        <div ref={endRef} />
      </div>
      {ctx && (
        // ADR-039 context meter — a hairline above the composer (mirrors the web app's ContextMeter).
        // Color grades against the AUTO-COMPACT threshold, not the raw window: amber at 80% of the
        // trigger, red past it. Hover for exact numbers.
        <div
          style={styles.ctxBar}
          title={`Context: ${ctx.used.toLocaleString()} / ${ctx.window.toLocaleString()} tokens (${Math.round((ctx.used / ctx.window) * 100)}%) — compacts at ${ctx.auto.toLocaleString()}`}
        >
          <div
            style={{
              ...styles.ctxFill,
              width: `${Math.min(100, (ctx.used / ctx.window) * 100)}%`,
              background:
                ctx.used >= ctx.auto
                  ? 'var(--vscode-errorForeground, #c33)'
                  : ctx.used >= ctx.auto * 0.8
                    ? 'var(--vscode-charts-yellow, #cc3)'
                    : 'var(--vscode-progressBar-background, var(--vscode-button-background))',
            }}
          />
        </div>
      )}
      {attached.length > 0 && (
        <div style={styles.attachRow}>
          {attached.map((u, i) => (
            <span key={i} style={styles.attachChip}>
              <img src={u} style={styles.attachImg} alt="attachment" />
              <button style={styles.attachRemove} title="Remove" onClick={() => setAttached((a) => a.filter((_x, ix) => ix !== i))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ ...styles.composerWrap, ...(ctx ? { borderTop: 'none' } : undefined) }}>
        {slashMatches.length > 0 && (
          <div style={styles.slashMenu}>
            {slashMatches.map((c) => (
              <button key={c.cmd} style={styles.slashItem} onClick={() => pickSlash(c)}>
                <span style={styles.slashCmd}>{c.cmd}</span>
                <span style={styles.slashDesc}>{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="cascade-composer-box" style={styles.composerBox}>
          <textarea
            style={styles.inputBare}
            value={input}
            placeholder="Ask Cascade…  (type / for commands, paste images)"
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div style={styles.composerRow}>
            <button className="cascade-icon-action" style={styles.iconAction} title="Attach image" onClick={() => fileRef.current?.click()}>
              +
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onFilePick} />
            <div style={{ position: 'relative', minWidth: 0 }}>
              {modelMenu && (
                <>
                  <div style={styles.menuBackdrop} onClick={() => setModelMenu(false)} />
                  <div style={styles.modelMenu}>
                    {(modelData?.enabled ?? []).map((m) => {
                      const active = m.model === modelData?.settings.model && m.provider === modelData?.settings.provider
                      return (
                        <button
                          key={`${m.provider}/${m.model}`}
                          className="cascade-menu-item" style={{ ...styles.modelMenuItem, fontWeight: active ? 700 : 400 }}
                          onClick={() => {
                            setModelMenu(false)
                            if (!active) vscode.postMessage({ type: 'activateModel', provider: m.provider, model: m.model })
                          }}
                        >
                          <span style={styles.menuProvider}>{m.provider}</span>
                          <span style={styles.mmCatName}>
                            {active ? '✓ ' : ''}
                            {m.model}
                          </span>
                          {m.contextWindow ? <span style={styles.mmCatSize}>{Math.round(m.contextWindow / 1000)}k</span> : null}
                        </button>
                      )
                    })}
                    {(modelData?.enabled?.length ?? 0) > 0 && <div style={styles.menuDivider} />}
                    <button
                      className="cascade-menu-item"
                      style={styles.modelMenuItem}
                      onClick={() => {
                        setModelMenu(false)
                        runCommand('/models')
                      }}
                    >
                      ⊞ Language models…
                    </button>
                    <button
                      className="cascade-menu-item"
                      style={styles.modelMenuItem}
                      onClick={() => {
                        setModelMenu(false)
                        vscode.postMessage({ type: 'openSettings' })
                      }}
                    >
                      ⚙ Cascade settings…
                    </button>
                  </div>
                </>
              )}
              <button className="cascade-chip" style={styles.modelChip} title="Switch model" onClick={() => setModelMenu((o) => !o)}>
                {modelData?.settings.model || '⚙ models'} ▾
              </button>
            </div>
            <div style={{ position: 'relative' }}>
              {modeMenu && (
                <>
                  <div style={styles.menuBackdrop} onClick={() => setModeMenu(false)} />
                  <div style={styles.modelMenu}>
                    {(['default', 'acceptEdits', 'plan', 'bypass'] as const).map((m) => (
                      <button
                        key={m}
                        className="cascade-menu-item" style={{ ...styles.modelMenuItem, fontWeight: m === modelData?.settings.permissionMode ? 700 : 400 }}
                        onClick={() => {
                          setModeMenu(false)
                          vscode.postMessage({ type: 'setModelConfig', patch: { permissionMode: m } })
                        }}
                      >
                        {m === modelData?.settings.permissionMode ? '✓ ' : ''}
                        {m}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <button className="cascade-chip" style={styles.modelChip} title="Permission mode (how tool calls are approved)" onClick={() => setModeMenu((o) => !o)}>
                🛡 {modelData?.settings.permissionMode ?? 'default'} ▾
              </button>
            </div>
            <span style={{ flex: 1 }} />
            {busy ? (
              <button style={{ ...styles.send, ...styles.stop }} onClick={stop}>
                ■ Stop
              </button>
            ) : (
              <button style={styles.send} onClick={send}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-foreground)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  title: { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.7 },
  newChat: {
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
  },
  headerRight: { display: 'flex', gap: 6, alignItems: 'center' },
  staleBanner: {
    padding: '6px 12px',
    fontSize: 11.5,
    lineHeight: 1.5,
    color: 'var(--vscode-inputValidation-warningForeground, var(--vscode-foreground))',
    background: 'var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.12))',
    borderBottom: '1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border))',
  },
  modelChip: {
    background: 'var(--vscode-badge-background, rgba(255,255,255,0.08))',
    color: 'var(--vscode-badge-foreground, inherit)',
    border: 'none',
    borderRadius: 9,
    padding: '2px 8px',
    fontSize: 10.5,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    cursor: 'pointer',
    maxWidth: 160,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Model manager form
  mmRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' },
  mmLabel: { width: 92, flexShrink: 0, fontSize: 11, opacity: 0.75 },
  mmInput: {
    flex: 1,
    minWidth: 0,
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: 4,
    padding: '4px 8px',
    fontFamily: 'inherit',
    fontSize: 12,
  },
  mmGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px', margin: '8px 0' },
  // The boxed composer (screenshot-2 layout): textarea on top, action row underneath, one border around.
  composerWrap: { position: 'relative', padding: 8, borderTop: '1px solid var(--vscode-panel-border)' },
  composerBox: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: 6,
    padding: 6,
  },
  inputBare: {
    resize: 'none',
    background: 'transparent',
    color: 'var(--vscode-input-foreground)',
    border: 'none',
    outline: 'none',
    padding: '2px 4px 6px',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  composerRow: { display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4, borderTop: '1px solid var(--vscode-panel-border)' },
  iconAction: {
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 4,
    width: 22,
    height: 22,
    lineHeight: '18px',
    fontSize: 14,
    cursor: 'pointer',
    padding: 0,
  },
  menuBackdrop: { position: 'fixed', inset: 0, zIndex: 15 },
  modelMenu: {
    position: 'absolute',
    bottom: 'calc(100% + 4px)',
    left: 0,
    zIndex: 20,
    minWidth: 230,
    maxWidth: 320,
    maxHeight: 260,
    overflowY: 'auto',
    background: 'var(--vscode-editorWidget-background)',
    border: '1px solid var(--vscode-widget-border, var(--vscode-panel-border))',
    borderRadius: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    padding: 4,
  },
  modelMenuItem: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: 8,
    padding: '5px 8px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 12,
  },
  menuDivider: { height: 1, background: 'var(--vscode-panel-border)', margin: '4px 2px' },
  menuProvider: { minWidth: 52, fontSize: 10.5, opacity: 0.6, flexShrink: 0 },
  mmCatalog: {
    maxHeight: 140,
    overflowY: 'auto',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 6,
    padding: '2px 8px',
    margin: '2px 0 6px',
  },
  mmCatRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderBottom: '1px solid var(--vscode-panel-border)' },
  mmCatName: { flex: 1, minWidth: 0, fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mmCatSize: { opacity: 0.55 },
  mmCell: { display: 'flex', alignItems: 'center', gap: 6 },
  mmInfo: {
    margin: '8px 0 2px',
    padding: '6px 8px',
    fontSize: 11.5,
    opacity: 0.8,
    background: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2))',
    borderRadius: 4,
  },
  chatPicker: {
    flex: 1,
    minWidth: 0,
    margin: '0 8px',
    background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
    color: 'var(--vscode-dropdown-foreground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
    borderRadius: 4,
    padding: '2px 4px',
    fontSize: 11,
  },
  transcript: { flex: 1, overflowY: 'auto', padding: '8px 12px' },
  bubble: { margin: '8px 0', padding: '8px 11px', borderRadius: 8 },
  user: {
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, transparent)',
  },
  assistant: { background: 'var(--vscode-editorWidget-background)' },
  role: {
    fontSize: 10.5,
    opacity: 0.55,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: 600,
    marginBottom: 6,
  },
  text: { whiteSpace: 'pre-wrap' },
  thinking: { marginBottom: 6, opacity: 0.85 },
  thinkingSummary: { cursor: 'pointer', fontSize: 11, opacity: 0.7, userSelect: 'none' },
  thinkingBody: {
    whiteSpace: 'pre-wrap',
    fontSize: 12,
    opacity: 0.75,
    marginTop: 4,
    paddingLeft: 8,
    borderLeft: '2px solid var(--vscode-panel-border)',
  },
  status: { opacity: 0.7, fontStyle: 'italic', padding: '6px 8px' },
  recoverCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '8px 0',
    padding: '8px 11px',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--vscode-inputValidation-warningForeground, var(--vscode-foreground))',
    background: 'var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.08))',
    border: '1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border))',
  },
  recoverAttempt: { opacity: 0.6 },
  memoryMarker: {
    margin: '4px 0',
    padding: '3px 10px',
    fontSize: 11,
    opacity: 0.7,
    fontStyle: 'italic',
    borderLeft: '2px solid var(--vscode-charts-purple, #a86)',
  },
  compactMarker: {
    margin: '6px 0',
    padding: '3px 10px',
    fontSize: 11,
    opacity: 0.7,
    fontStyle: 'italic',
    textAlign: 'center',
    borderTop: '1px dashed var(--vscode-panel-border)',
    borderBottom: '1px dashed var(--vscode-panel-border)',
  },
  caret: { opacity: 0.6 },
  // Permission card — blocks the loop until the user answers.
  permCard: {
    margin: '8px 0',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border))',
    background: 'var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background))',
  },
  permTitle: { fontWeight: 600, marginBottom: 4 },
  permDetail: { fontSize: 12, opacity: 0.85, marginBottom: 8 },
  permButtons: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  permBtn: {
    background: 'var(--vscode-button-secondaryBackground, transparent)',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  permAllow: { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none' },
  permDeny: { color: 'var(--vscode-errorForeground)' },
  // AskUserQuestion card (ADR-043) — blocks the loop until the user answers.
  qCard: {
    margin: '8px 0',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--vscode-focusBorder, var(--vscode-panel-border))',
    background: 'var(--vscode-editorWidget-background)',
  },
  qTitle: { fontWeight: 600, fontSize: 12, marginBottom: 8, color: 'var(--vscode-textLink-foreground)' },
  qDivider: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--vscode-panel-border)' },
  qChip: {
    fontSize: 10.5,
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: 4,
    background: 'var(--vscode-badge-background, rgba(255,255,255,0.08))',
    color: 'var(--vscode-badge-foreground, inherit)',
  },
  qQuestion: { fontWeight: 600, margin: '6px 0 8px' },
  qOptions: { display: 'flex', flexDirection: 'column', gap: 5 },
  qOpt: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '6px 9px',
    borderRadius: 6,
    border: '1px solid var(--vscode-panel-border)',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  qOptOn: {
    border: '1px solid var(--vscode-focusBorder, var(--vscode-button-background))',
    background: 'var(--vscode-list-activeSelectionBackground, rgba(90,140,255,0.12))',
  },
  qBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    marginTop: 1,
    flexShrink: 0,
    fontSize: 10,
    border: '1px solid var(--vscode-checkbox-border, var(--vscode-panel-border))',
    background: 'var(--vscode-checkbox-background, transparent)',
  },
  qBoxOn: {
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: '1px solid var(--vscode-button-background)',
  },
  qOptLabel: { fontWeight: 600 },
  qOptDesc: { display: 'block', fontSize: 11.5, opacity: 0.7 },
  qOther: {
    marginTop: 2,
    padding: '6px 9px',
    borderRadius: 6,
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  qSubmit: {
    marginTop: 10,
    width: '100%',
    padding: '5px 0',
    borderRadius: 6,
    border: 'none',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    fontWeight: 600,
    cursor: 'pointer',
  },
  qSubmitOff: {
    background: 'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
    color: 'var(--vscode-disabledForeground, #888)',
    cursor: 'default',
  },
  // Answered-question record (read-only, in the transcript)
  qAnswered: {
    margin: '8px 0',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editorWidget-background)',
    fontSize: 12.5,
  },
  qAnsweredRow: { display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 3 },
  qAnsweredCheck: { color: 'var(--vscode-charts-green, #3a3)', flexShrink: 0 },
  qAnsweredQ: { opacity: 0.7 },
  qAnsweredA: { fontWeight: 600 },
  // Tool cards
  toolCard: {
    margin: '6px 0',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 6,
    background: 'var(--vscode-editorWidget-background)',
    overflow: 'hidden',
  },
  toolHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 12 },
  toolName: { fontWeight: 600, fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  toolSummary: { opacity: 0.7 },
  todoCard: { margin: '6px 0', border: '1px solid var(--vscode-panel-border)', borderRadius: 6, background: 'var(--vscode-editorWidget-background)', padding: '4px 0 6px' },
  todoHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px 6px', fontSize: 12 },
  todoCount: { marginLeft: 'auto', opacity: 0.6, fontSize: 11, fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  todoBody: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 10px', fontSize: 12 },
  todoRow: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  todoDone: { color: 'var(--vscode-charts-green, #3a3)' },
  todoPending: { opacity: 0.5 },
  toolPreview: {
    margin: 0,
    padding: '6px 10px',
    borderTop: '1px solid var(--vscode-panel-border)',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 11,
    opacity: 0.75,
    whiteSpace: 'pre-wrap',
    maxHeight: 120,
    overflow: 'auto',
  },
  // Inline file-edit diff (extension panel)
  diffBlock: {
    borderTop: '1px solid var(--vscode-panel-border)',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 11,
    lineHeight: 1.5,
    maxHeight: 320,
    overflow: 'auto',
  },
  diffAdd: {
    whiteSpace: 'pre-wrap',
    padding: '0 10px',
    color: 'var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #3a3))',
    background: 'var(--vscode-diffEditor-insertedTextBackground, rgba(0,200,0,0.10))',
  },
  diffDel: {
    whiteSpace: 'pre-wrap',
    padding: '0 10px',
    color: 'var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red, #c33))',
    background: 'var(--vscode-diffEditor-removedTextBackground, rgba(200,0,0,0.10))',
  },
  diffCtx: { whiteSpace: 'pre-wrap', padding: '0 10px', opacity: 0.65 },
  // Context meter (ADR-039): the hairline separator above the composer doubles as an occupancy bar.
  ctxBar: { height: 3, background: 'var(--vscode-panel-border)', cursor: 'default' },
  ctxFill: { height: '100%', transition: 'width 0.4s ease' },
  // Pending image attachments (pasted into the composer, sent with the next turn).
  attachRow: { display: 'flex', gap: 6, padding: '6px 8px 0', flexWrap: 'wrap' },
  attachChip: { position: 'relative', display: 'inline-block' },
  attachImg: {
    width: 44,
    height: 44,
    objectFit: 'cover',
    borderRadius: 4,
    border: '1px solid var(--vscode-panel-border)',
    display: 'block',
  },
  attachRemove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 15,
    height: 15,
    lineHeight: '13px',
    fontSize: 9,
    padding: 0,
    borderRadius: '50%',
    border: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editorWidget-background)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
  },
  // Images inside a committed user bubble.
  userImgs: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
  userImg: { maxWidth: 120, maxHeight: 90, borderRadius: 4, border: '1px solid var(--vscode-panel-border)' },
  composer: { position: 'relative', display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--vscode-panel-border)' },
  input: {
    flex: 1,
    resize: 'none',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: 4,
    padding: 6,
    fontFamily: 'inherit',
  },
  send: {
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: 4,
    padding: '3px 12px',
    fontSize: 12,
    cursor: 'pointer',
  },
  stop: {
    background: 'var(--vscode-errorForeground, #c33)',
    color: 'var(--vscode-button-foreground, #fff)',
  },
  // Slash-command menu (pops above the composer)
  slashMenu: {
    position: 'absolute',
    bottom: 'calc(100% - 4px)',
    left: 8,
    right: 8,
    background: 'var(--vscode-editorWidget-background)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    overflow: 'hidden',
  },
  slashItem: {
    display: 'flex',
    width: '100%',
    gap: 8,
    alignItems: 'baseline',
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid var(--vscode-panel-border)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  slashCmd: { fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 },
  slashDesc: { opacity: 0.6, fontSize: 12 },
  // /mcp overlay (modal)
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '8vh',
    zIndex: 10,
  },
  modal: {
    width: 'min(560px, 92vw)',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-widget-border, var(--vscode-panel-border))',
    borderRadius: 10,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    overflow: 'hidden',
  },
  modalHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  modalTitle: { fontWeight: 600 },
  modalSub: { opacity: 0.6, fontSize: 12, flex: 1 },
  iconBtn: { background: 'transparent', border: 'none', color: 'var(--vscode-foreground)', cursor: 'pointer', fontSize: 14 },
  modalBody: { overflowY: 'auto', padding: '8px 14px' },
  modalFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  mcpEmpty: { fontSize: 12, opacity: 0.8, padding: '6px 0' },
  codeBlock: {
    marginTop: 6,
    padding: 8,
    background: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2))',
    borderRadius: 6,
    fontSize: 11,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    whiteSpace: 'pre',
    overflowX: 'auto',
  },
  serverCard: {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 8,
    padding: '8px 10px',
    margin: '8px 0',
    background: 'var(--vscode-editor-background)',
  },
  serverTop: { display: 'flex', alignItems: 'center', gap: 8 },
  statusDot: { fontSize: 12, width: 12, textAlign: 'center' },
  serverName: { fontWeight: 600, fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  statusLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' },
  spacer: { flex: 1 },
  linkBtn: { background: 'transparent', border: 'none', color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', fontSize: 12 },
  cardBtn: {
    background: 'var(--vscode-button-secondaryBackground, transparent)',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  cardBtnPrimary: { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none' },
  serverError: {
    marginTop: 6,
    padding: '6px 8px',
    fontSize: 12,
    color: 'var(--vscode-errorForeground)',
    background: 'var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.08))',
    border: '1px solid var(--vscode-inputValidation-errorBorder, transparent)',
    borderRadius: 4,
    whiteSpace: 'pre-wrap',
  },
  toolList: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 },
  toolChip: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 4,
    background: 'var(--vscode-badge-background, rgba(255,255,255,0.08))',
    color: 'var(--vscode-badge-foreground, inherit)',
  },
  mcpMeta: { opacity: 0.6, fontSize: 12 },
  // /memory overlay
  memSection: { fontSize: 11, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '10px 0 4px' },
  memSearchRow: { display: 'flex', gap: 6, margin: '8px 0' },
  memSearchInput: {
    flex: 1,
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: 4,
    padding: '4px 8px',
    fontFamily: 'inherit',
    fontSize: 12,
  },
  memRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12, borderBottom: '1px solid var(--vscode-panel-border)' },
  memText: { whiteSpace: 'pre-wrap' },
  memScore: { fontFamily: 'var(--vscode-editor-font-family, monospace)', opacity: 0.6, minWidth: 32 },
}
