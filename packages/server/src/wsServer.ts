// wsServer.ts — Cascade over WebSocket. (Phase 13.1 → 13.2)
//
// 13.1: each connection drove its own CascadeSession, and every ActivityEvent it yields is relayed back as
// JSON — the SAME protocol the VS Code extension uses in-process (ADR-018).
// 13.2: sessions are now owned by a server-wide ProjectManager and keyed by project. A connection ATTACHES
// to one project (its "active session") and routes submit/abort/etc to it; closing the socket detaches but
// does NOT dispose the session, so a project's conversation survives reconnects.
//
// Shape: a web server + a session relay decoupled from the transport.

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CascadeSession, InboundMessage } from '@cascade/core'
import { ProjectManager } from './projectManager.js'

const PORT = Number(process.env.CASCADE_PORT ?? 4319)
const MODEL = process.env.CASCADE_MODEL ?? 'qwen2.5-coder:latest'
const BASE_URL = process.env.CASCADE_BASE_URL || undefined
const PROJECTS_ROOT = process.env.CASCADE_PROJECTS_ROOT || join(process.cwd(), 'cascade-projects')

/**
 * Wire one WebSocket to the ProjectManager. Inbound JSON drives whichever project the connection has
 * opened (its `active` session); the `project` control message switches that. The session itself lives in
 * the manager, not here.
 */
export function handleConnection(ws: WebSocket, manager: ProjectManager): void {
  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  let active: CascadeSession | undefined
  let activeId: string | undefined

  // Greet the new connection with the current project list so the sidebar can render immediately.
  send({ type: 'projects', projects: manager.list(), activeId })

  // Return the active session, or nudge the user to open one. Captured into a const at each call site so
  // TS narrowing survives the `await`s that follow (a `let` closure var would re-widen).
  const requireActive = (): CascadeSession | undefined => {
    if (active) return active
    send({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '📂 Open or create a project first.' }] } })
    send({ type: 'turnDone', steps: 0 })
    return undefined
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
        case 'project': {
          if (msg.action === 'create' && msg.name) manager.create(msg.name)
          else if (msg.action === 'delete' && msg.id) {
            await manager.delete(msg.id)
            if (activeId === msg.id) ((active = undefined), (activeId = undefined))
          } else if (msg.action === 'open' && msg.id) {
            active = manager.open(msg.id)
            activeId = msg.id
          }
          send({ type: 'projects', projects: manager.list(), activeId })
          break
        }
        case 'submit': {
          const s = requireActive()
          if (!s) break
          for await (const ev of s.submit(msg.text)) send(ev)
          break
        }
        case 'permission':
          active?.respondPermission(msg.id, msg.decision)
          break
        case 'abort':
          active?.abort()
          break
        case 'reset':
          active?.reset()
          break
        case 'mcp': {
          const s = requireActive()
          if (!s) break
          if (msg.action === 'connect' && msg.server) s.mcpConnect(msg.server)
          else if (msg.action === 'disconnect' && msg.server) await s.mcpDisconnect(msg.server)
          send({ type: 'mcpStatus', servers: s.mcpStatuses() })
          break
        }
        case 'memoryView': {
          const s = requireActive()
          if (!s) break
          if (msg.action === 'forget' && msg.id) s.memoryForget(msg.id)
          const hits = msg.action === 'search' && msg.query ? await s.memorySearch(msg.query) : undefined
          const view = s.memoryView()
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

  // Detach only — the session stays alive in the manager for the next connection.
  ws.on('close', () => {
    active = undefined
    activeId = undefined
  })
}

function start() {
  const manager = new ProjectManager({ root: PROJECTS_ROOT, model: MODEL, baseUrl: BASE_URL })
  const wss = new WebSocketServer({ port: PORT })
  wss.on('connection', (ws) => handleConnection(ws, manager))
  const shutdown = () => void manager.dispose().finally(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  console.log(`Cascade server listening on ws://127.0.0.1:${PORT}  (model: ${MODEL}, projects: ${PROJECTS_ROOT})`)
}

// Run only when invoked directly (tsx src/wsServer.ts) — NOT when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start()
