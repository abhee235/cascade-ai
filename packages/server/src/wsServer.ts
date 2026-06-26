// wsServer.ts — Cascade over WebSocket. Each connection gets its own CascadeSession; inbound JSON
// (InboundMessage) drives the session, and every ActivityEvent it yields is relayed back as JSON. This is
// the SAME protocol the VS Code extension uses in-process — proving the core is frontend-agnostic (ADR-018).
//

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { createSession, createProvider, type CascadeSession, type InboundMessage } from '@cascade/core'

const PORT = Number(process.env.CASCADE_PORT ?? 4319)
const MODEL = process.env.CASCADE_MODEL ?? 'qwen2.5-coder:latest'
const BASE_URL = process.env.CASCADE_BASE_URL || undefined
// Phase 13.1: a single scoped workspace dir on the host (per-project dirs + Docker sandbox arrive in 13.2/13.3).
const WORKSPACE = process.env.CASCADE_WORKSPACE || join(process.cwd(), 'cascade-workspace')

/** Wire one WebSocket to one CascadeSession: inbound JSON → session calls; session ActivityEvents → JSON out. */
export function handleConnection(ws: WebSocket, session: CascadeSession): void {
  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  ws.on('message', async (data) => {
    let msg: InboundMessage
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return // ignore non-JSON
    }
    try {
      switch (msg.type) {
        case 'submit':
          for await (const ev of session.submit(msg.text)) send(ev)
          break
        case 'permission':
          session.respondPermission(msg.id, msg.decision)
          break
        case 'abort':
          session.abort()
          break
        case 'reset':
          session.reset()
          break
        case 'mcp': {
          if (msg.action === 'connect' && msg.server) session.mcpConnect(msg.server)
          else if (msg.action === 'disconnect' && msg.server) await session.mcpDisconnect(msg.server)
          send({ type: 'mcpStatus', servers: session.mcpStatuses() })
          break
        }
        case 'memoryView': {
          if (msg.action === 'forget' && msg.id) session.memoryForget(msg.id)
          const hits = msg.action === 'search' && msg.query ? await session.memorySearch(msg.query) : undefined
          const view = session.memoryView()
          send({ type: 'memoryData', core: view.core, archival: view.archival, hits })
          break
        }
      }
    } catch (e) {
      // Never let a handler error kill the socket — surface it like the session would.
      send({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `⚠️ ${e instanceof Error ? e.message : String(e)}` }] } })
      send({ type: 'turnDone', steps: 0 })
    }
  })

  ws.on('close', () => void session.dispose())
}

function start() {
  mkdirSync(WORKSPACE, { recursive: true })
  const wss = new WebSocketServer({ port: PORT })
  wss.on('connection', (ws) => {
    const provider = createProvider({ provider: 'ollama', model: MODEL, baseUrl: BASE_URL })
    const session = createSession({ cwd: WORKSPACE, provider, model: MODEL })
    handleConnection(ws, session)
  })
  console.log(`Cascade server listening on ws://127.0.0.1:${PORT}  (model: ${MODEL}, workspace: ${WORKSPACE})`)
}

// Run only when invoked directly (tsx src/wsServer.ts) — NOT when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start()
