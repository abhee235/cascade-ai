import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { mermaid } from '@streamdown/mermaid'
import { createMathPlugin } from '@streamdown/math'
import { createCodePlugin } from '@streamdown/code'
import type { ActivityEvent, Message } from '@cascade/core'

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

// Transcript items: user/assistant messages and tool cards, interleaved in order.
type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; thinking?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; preview?: string }
  | { kind: 'memory'; text: string }
  | { kind: 'compacted'; text: string }

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
]
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
  const [busy, setBusy] = useState(false)
  const [mcp, setMcp] = useState<{ name: string; status: string; error?: string; toolNames: string[] }[] | null>(null)
  const [mem, setMem] = useState<{ core: string; archival: { id: string; text: string; ts: string }[]; hits?: { text: string; score: number }[] } | null>(null)
  const [memQuery, setMemQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

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
    function onMessage(e: MessageEvent<ActivityEvent>) {
      const event = e.data
      switch (event.type) {
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
                ? { ...x, status: event.ok ? 'ok' : 'error', preview: event.preview }
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
            { kind: 'compacted', text: event.kind === 'summarized' ? 'summarized older turns' : 'masked old tool output' },
          ])
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

  // Slash commands (the `/` menu). Add more here as the app grows.
  const slashMatches = input.startsWith('/') ? COMMANDS.filter((c) => c.cmd.startsWith(input.trim())) : []

  function runCommand(cmd: string) {
    setInput('')
    if (cmd === '/mcp') vscode.postMessage({ type: 'mcp', action: 'list' }) // opens the overlay (mcpStatus reply)
    if (cmd === '/memory') vscode.postMessage({ type: 'memoryView', action: 'list' }) // opens the memory overlay
  }

  function memAction(action: 'list' | 'search' | 'forget', extra?: { query?: string; id?: string }) {
    vscode.postMessage({ type: 'memoryView', action, query: extra?.query, id: extra?.id })
  }

  function send() {
    const text = input.trim()
    if (!text) return
    if (text.startsWith('/')) {
      // Run the exact command, or the single remaining suggestion if the user typed a prefix.
      const exact = COMMANDS.find((c) => c.cmd === text)
      if (exact) return runCommand(exact.cmd)
      if (slashMatches.length === 1) return runCommand(slashMatches[0].cmd)
      return // unknown/ambiguous slash input — do nothing (the menu is showing options)
    }
    setItems((it) => [...it, { kind: 'user', text }])
    setInput('')
    setBusy(true)
    vscode.postMessage({ type: 'submit', text })
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
  }

  function respond(decision: 'allow' | 'allow-always' | 'deny') {
    if (!prompt) return
    vscode.postMessage({ type: 'permission', id: prompt.id, decision })
    setPrompt(null) // optimistic; the core resumes and the tool card will follow
  }

  function newChat() {
    setItems([])
    setStreaming(null)
    setStatus(null)
    setPrompt(null)
    setBusy(false)
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
      <div style={styles.header}>
        <span style={styles.title}>Cascade</span>
        <button style={styles.newChat} onClick={newChat}>
          + New chat
        </button>
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
                <div style={styles.text}>{it.text}</div>
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
                : "Can't reach the model (Ollama) — reconnecting…"}{' '}
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
      <div style={styles.composer}>
        {slashMatches.length > 0 && (
          <div style={styles.slashMenu}>
            {slashMatches.map((c) => (
              <button key={c.cmd} style={styles.slashItem} onClick={() => runCommand(c.cmd)}>
                <span style={styles.slashCmd}>{c.cmd}</span>
                <span style={styles.slashDesc}>{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          style={styles.input}
          value={input}
          placeholder="Ask Cascade…  (type / for commands)"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
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
    padding: '0 12px',
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
