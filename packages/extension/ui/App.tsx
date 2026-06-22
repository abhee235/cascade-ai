import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { mermaid } from '@streamdown/mermaid'
import { createMathPlugin } from '@streamdown/math'
import { createCodePlugin } from '@streamdown/code'
import type { ActivityEvent, Message } from '@cascade/core'

// VS Code injects this into the webview global scope.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }
const vscode = acquireVsCodeApi()

// Shiki ships a dual [light, dark] theme and switches via a `.dark` class — that switch is unreliable
// in the webview, so we detect VS Code's theme once and pin BOTH slots to the matching Shiki theme.
// Guarantees correct contrast (high-contrast → strong colors regardless of switching).
const cls = document.body.classList
const codeTheme = cls.contains('vscode-light') ? 'github-light' : 'github-dark'

// All Streamdown plugins in one place. `code` = Shiki highlighting (pure-JS engine → no WASM/CSP).
// singleDollarTextMath: true enables inline `$…$` (off by default to avoid clashing with currency).
const mdPlugins = {
  mermaid,
  math: createMathPlugin({ singleDollarTextMath: true }),
  code: createCodePlugin({ themes: [codeTheme, codeTheme] }),
}

// Models often emit LaTeX-style math delimiters \[ … \] (display) and \( … \) (inline), which
// remark-math does NOT parse (it only knows $/$$). Convert them — but only OUTSIDE code spans/blocks
// (the split keeps ``` fences and `inline code` as odd-indexed segments, which we leave untouched).
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
// Single render path for all assistant markdown (answer + thinking).
function Md({ children }: { children: string }) {
  return <Streamdown plugins={mdPlugins}>{normalizeMath(children)}</Streamdown>
}

type Bubble = { role: 'user' | 'assistant'; text: string; thinking?: string }

// Split an assistant message into its answer text and its (optional) reasoning.
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

export function App() {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
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
        case 'message': {
          // Finalize: commit the authoritative message and clear the live buffer.
          const { text, thinking } = extract(event.message)
          setBubbles((b) => [...b, { role: 'assistant', text, thinking: thinking || undefined }])
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
  }, [bubbles, streaming, status])

  function send() {
    const text = input.trim()
    if (!text) return
    setBubbles((b) => [...b, { role: 'user', text }])
    setInput('')
    vscode.postMessage({ type: 'submit', text })
  }

  return (
    <div style={styles.app}>
      <div style={styles.transcript}>
        {bubbles.map((b, i) => (
          <div key={i} style={{ ...styles.bubble, ...(b.role === 'user' ? styles.user : styles.assistant) }}>
            <div style={styles.role}>{b.role}</div>
            {b.thinking && (
              <details style={styles.thinking}>
                <summary style={styles.thinkingSummary}>💭 Thinking</summary>
                <div style={styles.thinkingBody} className="cascade-md">
                  <Md>{b.thinking}</Md>
                </div>
              </details>
            )}
            {b.role === 'assistant' ? (
              <div className="cascade-md">
                <Md>{b.text}</Md>
              </div>
            ) : (
              <div style={styles.text}>{b.text}</div>
            )}
          </div>
        ))}
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
              <span style={styles.caret}>▋</span>
            </div>
          </div>
        )}
        {status && !streaming && <div style={styles.status}>⏺ {status}</div>}
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
