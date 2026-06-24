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

export function App() {
  const [items, setItems] = useState<Item[]>([])
  const [streaming, setStreaming] = useState<{ text: string; thinking: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMessage(e: MessageEvent<ActivityEvent>) {
      const event = e.data
      switch (event.type) {
        case 'status':
          setStatus(event.text)
          break
        case 'thinking_delta':
          setStreaming((s) => ({ text: s?.text ?? '', thinking: (s?.thinking ?? '') + event.thinking }))
          break
        case 'text_delta':
          setStreaming((s) => ({ text: (s?.text ?? '') + event.text, thinking: s?.thinking ?? '' }))
          break
        case 'toolStart':
          // A tool is running — drop any transient pre-tool text and add a card.
          setStreaming(null)
          setItems((it) => [...it, { kind: 'tool', id: event.id, name: event.name, summary: event.summary, status: 'running' }])
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
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streaming, status])

  function send() {
    const text = input.trim()
    if (!text) return
    setItems((it) => [...it, { kind: 'user', text }])
    setInput('')
    vscode.postMessage({ type: 'submit', text })
  }

  function newChat() {
    setItems([])
    setStreaming(null)
    setStatus(null)
    vscode.postMessage({ type: 'reset' })
  }

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <span style={styles.title}>Cascade</span>
        <button style={styles.newChat} onClick={newChat}>
          + New chat
        </button>
      </div>
      <div style={styles.transcript}>
        {items.map((it, i) =>
          it.kind === 'tool' ? (
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
        {status && !streaming && (
          <div style={styles.status}>
            <span className="cascade-spinner" /> {status}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div style={styles.composer}>
        <textarea
          style={styles.input}
          value={input}
          placeholder="Ask Cascade…"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button style={styles.send} onClick={send}>
          Send
        </button>
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
  caret: { opacity: 0.6 },
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
  composer: { display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--vscode-panel-border)' },
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
}
