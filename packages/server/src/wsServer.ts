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
import type { BuilderCommand } from '@cascade/app-protocol'
import { ProjectManager } from './projectManager.js'
import { DockerSandbox, dockerAvailable, sweepSandboxContainers } from './dockerSandbox.js'
import { listTemplates } from './templates.js'
import { readDiff, readFile, readTree } from './fileService.js'
import { PreviewManager } from './previewManager.js'
import { PreviewProxy } from './previewProxy.js'
import { runCheck } from './checkProject.js'
import { VersionManager } from './versionManager.js'

/** What a connection can receive: a core session message OR an app/builder command. */
type Inbound = InboundMessage | BuilderCommand

const PORT = Number(process.env.CASCADE_PORT ?? 4319)
const PREVIEW_PORT = Number(process.env.CASCADE_PREVIEW_PORT ?? 4320) // M5.2: stable preview-proxy origin
const MODEL = process.env.CASCADE_MODEL ?? 'qwen2.5-coder:latest'
const BASE_URL = process.env.CASCADE_BASE_URL || undefined
const PROJECTS_ROOT = process.env.CASCADE_PROJECTS_ROOT || join(process.cwd(), 'cascade-projects')

/**
 * Wire one WebSocket to the ProjectManager. Inbound JSON drives whichever project the connection has
 * opened (its `active` session); the `project` control message switches that. The session itself lives in
 * the manager, not here.
 */
export function handleConnection(
  ws: WebSocket,
  manager: ProjectManager,
  preview?: PreviewManager,
  previewProxy?: PreviewProxy,
  previewPort?: number,
  versions?: VersionManager,
): void {
  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  let active: CascadeSession | undefined
  let activeId: string | undefined
  let stopTail: (() => void) | undefined // M5: stops the Console log stream (tail) for this connection

  // Send a preview status to the client. When it's running, point the proxy at the container and hand the
  // client the STABLE proxy origin instead of the container's random port (M5.2).
  const emitPreview = (s: { status: string; url?: string }) => {
    if (s.status === 'running' && s.url && previewProxy && previewPort) {
      previewProxy.setTarget(Number(new URL(s.url).port))
      send({ type: 'preview', status: 'running', url: `http://localhost:${previewPort}` })
    } else {
      send({ type: 'preview', status: s.status, url: s.url })
    }
  }

  // Start streaming the active project's dev-server log into the Console pane (`log` events). Replaces any
  // existing tail (e.g. when switching projects). No-op without Docker / a PreviewManager.
  const startTail = (id: string) => {
    const sandbox = manager.sandboxOf(id)
    if (!preview || !(sandbox instanceof DockerSandbox)) return
    stopTail?.()
    stopTail = preview.tail(id, sandbox, (line) => send({ type: 'log', line }))
  }

  // Greet the new connection with the project list + available templates so the UI can render immediately.
  send({ type: 'projects', projects: manager.list(), activeId })
  send({ type: 'templates', templates: listTemplates() })

  // Send the active project's file tree (M4) — on open and after each turn (the agent may have edited files).
  const sendTree = () => {
    const dir = activeId && manager.dirOf(activeId)
    if (dir) send({ type: 'files', tree: readTree(dir) })
  }

  // Send the active project's checkpoint history (M6).
  const sendVersions = () => {
    const dir = activeId && manager.dirOf(activeId)
    if (dir && versions) send({ type: 'versions', versions: versions.list(dir) })
  }

  // Return the active session, or nudge the user to open one. Captured into a const at each call site so
  // TS narrowing survives the `await`s that follow (a `let` closure var would re-widen).
  const requireActive = (): CascadeSession | undefined => {
    if (active) return active
    send({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '📂 Open or create a project first.' }] } })
    send({ type: 'turnDone', steps: 0 })
    return undefined
  }

  ws.on('message', async (data) => {
    let msg: Inbound
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return // ignore non-JSON
    }
    try {
      switch (msg.type) {
        case 'project': {
          if (msg.action === 'create' && msg.name) {
            const created = manager.create(msg.name, msg.templateId)
            send({ type: 'projectCreated', project: created })
          }
          else if (msg.action === 'delete' && msg.id) {
            await manager.delete(msg.id)
            if (activeId === msg.id) ((active = undefined), (activeId = undefined))
          } else if (msg.action === 'open' && msg.id) {
            stopTail?.() // detach the previous project's log stream before switching
            stopTail = undefined
            active = manager.open(msg.id)
            activeId = msg.id
          }
          send({ type: 'projects', projects: manager.list(), activeId })
          if (msg.action === 'open') {
            sendTree() // populate the Code pane for the opened project
            sendVersions() // populate the Versions panel (M6)
            const pv = activeId && preview?.state(activeId) // re-show a preview already running for this project
            if (pv) {
              emitPreview(pv)
              if (pv.status === 'running' && activeId) startTail(activeId) // resume its Console logs
            }
          }
          break
        }
        case 'submit': {
          const s = requireActive()
          if (!s) break
          for await (const ev of s.submit(msg.text)) send(ev)
          sendTree() // the agent may have created/edited files — refresh the tree
          // M6: checkpoint the turn's file changes (no-op if nothing changed), then refresh the history.
          const dir = activeId && manager.dirOf(activeId)
          if (dir && versions?.checkpoint(dir, msg.text)) sendVersions()
          break
        }
        case 'files': // request the active project's file tree
          sendTree()
          break
        case 'file': { // request one file's content (read) or its diff vs HEAD (diff)
          const dir = activeId ? manager.dirOf(activeId) : undefined
          if (!dir) break
          try {
            if (msg.action === 'diff') {
              const { original, modified } = readDiff(dir, msg.path)
              send({ type: 'fileDiff', path: msg.path, original, modified })
            } else {
              const { content, truncated } = readFile(dir, msg.path)
              send({ type: 'fileContent', path: msg.path, content, truncated })
            }
          } catch (e) {
            send({ type: 'fileContent', path: msg.path, content: `⚠️ ${(e as Error).message}`, truncated: false })
          }
          break
        }
        case 'preview': { // start/stop the active project's live preview (M3)
          if (!activeId || !preview) break
          if (msg.action === 'stop') {
            stopTail?.()
            stopTail = undefined
            previewProxy?.setTarget(null) // detach the proxy from the (now stopped) preview
            preview.stop(activeId)
            send({ type: 'preview', status: 'stopped' })
            break
          }
          const sandbox = manager.sandboxOf(activeId)
          if (sandbox instanceof DockerSandbox) {
            const id = activeId
            void preview.start(id, sandbox, (s) => {
              emitPreview(s)
              if (s.status === 'running') startTail(id) // begin streaming dev-server logs to the Console pane
            })
          } else {
            // No Docker ⇒ no isolated dev server. (Running on the host is out of scope for v1.)
            send({ type: 'preview', status: 'error' })
          }
          break
        }
        case 'check': { // M5.3: run a type-check in the sandbox and return structured problems
          if (!activeId) break
          const sandbox = manager.sandboxOf(activeId)
          if (!(sandbox instanceof DockerSandbox)) {
            send({ type: 'problems', problems: [], checking: false })
            break
          }
          send({ type: 'problems', problems: [], checking: true })
          const problems = await runCheck(sandbox)
          send({ type: 'problems', problems, checking: false })
          break
        }
        case 'versions': // M6: list checkpoints
          sendVersions()
          break
        case 'version': { // M6: restore the project to a checkpoint
          const dir = activeId && manager.dirOf(activeId)
          if (dir && versions && msg.action === 'restore') {
            versions.restore(dir, msg.id)
            sendTree() // files changed on disk → refresh the Code pane (the preview hot-reloads on its own)
            sendVersions()
          }
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
    stopTail?.() // end the Console log stream (the dev server itself stays up in the container)
    stopTail = undefined
    active = undefined
    activeId = undefined
  })
}

async function start() {
  // 13.3: isolate each project's command execution in its own Docker container when Docker is available.
  // Opt out with CASCADE_SANDBOX=off. Without Docker we fall back to HOST exec (usable, but not isolated).
  const sandboxEnabled = process.env.CASCADE_SANDBOX !== 'off'
  const hasDocker = sandboxEnabled && (await dockerAvailable())
  // Sweep sandbox containers orphaned by a previous run (a `--rm` sandbox stays alive via `tail -f`, so a
  // hard-killed server leaves them behind). Safe: project dirs are bind-mounted; the next exec recreates one.
  if (hasDocker) {
    const swept = await sweepSandboxContainers().catch(() => 0)
    if (swept) console.log(`Swept ${swept} orphaned sandbox container(s) from a previous run.`)
  }
  const sandboxFor = hasDocker ? (dir: string) => new DockerSandbox(dir) : undefined

  const manager = new ProjectManager({ root: PROJECTS_ROOT, model: MODEL, baseUrl: BASE_URL, sandboxFor })
  // M5.2: a stable preview origin. The proxy forwards http://localhost:PREVIEW_PORT → the active container,
  // and the dev server's HMR connects on PREVIEW_PORT too (same origin as the iframe).
  const previewProxy = hasDocker ? new PreviewProxy(PREVIEW_PORT) : undefined
  previewProxy?.listen()
  const preview = new PreviewManager(previewProxy ? PREVIEW_PORT : undefined)
  const versions = new VersionManager() // M6: git checkpoints/restore (stateless; runs git in each project dir)
  const wss = new WebSocketServer({ port: PORT })
  wss.on('connection', (ws) => handleConnection(ws, manager, preview, previewProxy, PREVIEW_PORT, versions))
  // Graceful exit (Ctrl-C / SIGTERM): dispose sessions + remove this run's sandbox containers. (A hard
  // SIGKILL skips this — the startup sweep above is the backstop.)
  const shutdown = () => void Promise.allSettled([manager.dispose(), sweepSandboxContainers()]).finally(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  console.log(
    `Cascade server listening on ws://127.0.0.1:${PORT}  (model: ${MODEL}, projects: ${PROJECTS_ROOT}, sandbox: ${hasDocker ? 'docker' : 'host'})`,
  )
  if (sandboxEnabled && !hasDocker)
    console.warn('⚠️  Docker not available — agent commands run on the HOST (no isolation). Install/start Docker Desktop for per-project sandboxing.')
}

// Run only when invoked directly (tsx src/wsServer.ts) — NOT when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start()
