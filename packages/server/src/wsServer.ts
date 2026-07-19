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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CascadeSession, InboundMessage } from '@cascade/core'
import type { BuilderCommand } from '@cascade/app-protocol'
import { ProjectManager } from './projectManager.js'
import { ensurePlanPersisted } from './planStage.js'
import { DockerSandbox, dockerAvailable, sweepSandboxContainers } from './dockerSandbox.js'
import { ensureVisualEditConfig, listTemplates } from './templates.js'
import { ChatStore } from './chatStore.js'
import type { ChatHistoryItem } from '@cascade/app-protocol'
import type { Message } from '@cascade/core'
import { createFile, deletePath, editJsxTextAtLoc, makeDir, readDiff, readFile, readTree, renamePath, setClassAtLoc, writeFile } from './fileService.js'
import { PreviewManager } from './previewManager.js'
import { PreviewProxy } from './previewProxy.js'
import { runCheck } from './checkProject.js'
import { VersionManager } from './versionManager.js'
import { createTerminal, type TerminalHandle } from './terminalSession.js'

/** What a connection can receive: a core session message OR an app/builder command. */
type Inbound = InboundMessage | BuilderCommand

const PORT = Number(process.env.CASCADE_PORT ?? 4319)
const PREVIEW_PORT = Number(process.env.CASCADE_PREVIEW_PORT ?? 4320) // M5.2: stable preview-proxy origin
const MODEL = process.env.CASCADE_MODEL ?? 'qwen2.5-coder:latest'
const BASE_URL = process.env.CASCADE_BASE_URL || undefined
const PROJECTS_ROOT = process.env.CASCADE_PROJECTS_ROOT || join(process.cwd(), 'cascade-projects')

// ── Security (M7) ──────────────────────────────────────────────────────────────────────────────────────
// Bind to localhost only by default (the `ws` `{ port }` form binds ALL interfaces — LAN-exposed). Override
// with CASCADE_HOST only when you knowingly want remote access (then also set CASCADE_ALLOWED_ORIGINS).
const HOST = process.env.CASCADE_HOST ?? '127.0.0.1'
// Browser clients must come from one of these origins (the Vite web app). A WebSocket is NOT protected by
// CORS/same-origin, so without this check ANY website you visit could open ws://127.0.0.1:4319 and drive the
// agent / a terminal (Cross-Site WebSocket Hijacking). Browsers always send a truthful Origin header.
const ALLOWED_ORIGINS = new Set([
  ...(process.env.CASCADE_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
  'http://localhost:5319',
  'http://127.0.0.1:5319',
])
// A per-run secret the legit web app fetches from GET /token (CORS-guarded to ALLOWED_ORIGINS, so a cross-site
// page can't read it) and presents as ?token= on the WS URL — defense-in-depth alongside the Origin check.
const WS_TOKEN = randomBytes(24).toString('hex')

/**
 * Wire one WebSocket to the ProjectManager. Inbound JSON drives whichever project the connection has
 * opened (its `active` session); the `project` control message switches that. The session itself lives in
 * the manager, not here.
 */
// M11: flatten a chat's core conversation into displayable transcript rows (user/assistant text + a compact
// line per tool call). Thinking and tool_result blocks are dropped — this is for rendering history, not replay.
function historyToItems(messages: Message[]): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      // Harness-injected <system-reminder> turns/blocks (todo gate, verify nudges, post-edit checks) are
      // invisible in the live UI — they must not resurface as fake user bubbles on reload.
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((b) => b.type === 'text')
              .map((b) => (b as { text: string }).text)
              .filter((t) => !t.trimStart().startsWith('<system-reminder>'))
              .join('')
      if (text.trim() && !text.trimStart().startsWith('<system-reminder>')) items.push({ role: 'user', text: text.trim() })
    } else {
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', text: b.text.trim() })
        else if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, text: summarizeToolInput(b.input) })
      }
    }
  }
  return items
}
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const key = o.path ?? o.file_path ?? o.command ?? o.pattern ?? o.query ?? o.filePath
  return typeof key === 'string' ? key.slice(0, 120) : ''
}

export function handleConnection(
  ws: WebSocket,
  manager: ProjectManager,
  preview?: PreviewManager,
  previewProxy?: PreviewProxy,
  previewPort?: number,
  versions?: VersionManager,
  chatStore?: ChatStore,
  serverInfo?: { sandbox: boolean; model: string },
): void {
  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  let active: CascadeSession | undefined
  let activeId: string | undefined
  let staging: CascadeSession | undefined // ADR-056 rung 3: the plan-stage session while it runs — user
  // responses (answer/permission/abort) must reach IT, not the builder, for the stage's duration.
  let stageAborted = false // abort during the stage cancels the WHOLE submit, not just the planner
  let activeChatId: string | undefined // M11: which chat (conversation) the active session is currently on
  let stopTail: (() => void) | undefined // M5: stops the Console log stream (tail) for this connection
  const terms = new Map<string, TerminalHandle>() // M7: the connection's terminal sessions, keyed by id
  const killAllTerms = () => {
    for (const t of terms.values()) t.kill()
    terms.clear()
  }

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

  // Greet the new connection with capabilities + the project list + available templates so the UI can render
  // immediately (serverInfo drives the Terminal's Docker gate and the Settings page).
  if (serverInfo) send({ type: 'serverInfo', ...serverInfo })
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

  // M11: send the active project's chat list (the active chat highlighted). list() prunes abandoned empty
  // "New chat" entries — the ACTIVE chat is exempt (it may be empty right now, mid-composition).
  const sendChats = () => {
    const dir = activeId && manager.dirOf(activeId)
    if (dir && chatStore && activeChatId) send({ type: 'chats', chats: chatStore.list(dir, activeChatId), activeId: activeChatId })
  }
  // M11: load a chat's saved conversation into the active session and send its transcript to render.
  const loadChat = (id: string) => {
    const dir = activeId && manager.dirOf(activeId)
    if (!dir || !chatStore || !active) return
    activeChatId = id
    active.loadHistory(chatStore.messages(dir, id))
    sendChats()
    // High-fidelity path: replay the ActivityEvents the client rendered live (identical transcript by
    // construction). The flattened items ride along as the fallback for pre-log chats.
    const events = chatStore.events(dir, id)
    send({ type: 'chatHistory', items: historyToItems(active.getHistory()), events: events.length ? events : undefined })
  }
  // M11: persist the current chat's conversation (and derive its title from the first user message).
  const saveChat = (firstUserText?: string) => {
    const dir = activeId && manager.dirOf(activeId)
    if (dir && chatStore && active && activeChatId) chatStore.save(dir, activeChatId, active.getHistory(), firstUserText)
  }
  // The REPLAY LOG (reload = live, measured gap: reloaded chats dropped thinking, diffs, tool status, and
  // leaked <system-reminder> walls). Only COMMITTED render events are logged — streaming deltas and
  // transient status are re-derivable noise; `question` is skipped (a replayed question card would look
  // answerable when the loop is long gone).
  const REPLAY_TYPES = new Set(['toolStart', 'toolResult', 'message', 'memory', 'compacted'])
  const logReplay = (entry: import('@cascade/app-protocol').ChatReplayEntry) => {
    const dir = activeId && manager.dirOf(activeId)
    if (dir && chatStore && activeChatId) chatStore.appendEvent(dir, activeChatId, entry)
  }
  const logEvent = (ev: { type: string }) => {
    if (REPLAY_TYPES.has(ev.type)) logReplay({ event: ev })
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
            killAllTerms() // close the previous project's terminals too
            active = manager.open(msg.id)
            activeId = msg.id
          }
          send({ type: 'projects', projects: manager.list(), activeId })
          if (msg.action === 'open') {
            sendTree() // populate the Code pane for the opened project
            sendVersions() // populate the Versions panel (M6)
            // M11: load the project's chats and restore the most-recent one's conversation into the session.
            const dir = activeId && manager.dirOf(activeId)
            if (dir && chatStore) loadChat(chatStore.list(dir)[0].id)
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
          // ADR-056 rung 3: first message of a fresh, unplanned project → run the planner as its own
          // top-level session FIRST (deterministic — planner-1 measured that asking the model doesn't
          // work). Its events (incl. AskUserQuestion) stream to the client on the same pipe; its
          // turnDone is swallowed so the UI sees ONE turn. Plan failure never blocks the build — the
          // builder proceeds and the core nudge remains as the in-session safety net.
          logReplay({ user: msg.text }) // the user row of the replay, FIRST — matching the live optimistic render
          const planner = activeId ? manager.planSessionFor(activeId) : undefined
          if (planner) {
            staging = planner
            send({ type: 'status', text: 'Planning first — writing PLAN.md…' })
            try {
              for await (const ev of planner.submit(msg.text)) {
                if (ev.type === 'turnDone') continue
                send(ev)
                logEvent(ev)
              }
            } finally {
              staging = undefined
              const dir = activeId && manager.dirOf(activeId)
              if (dir) ensurePlanPersisted(dir, planner) // guarantee PLAN.md (from the write, or the final message)
              await planner.dispose().catch(() => {})
            }
            sendTree() // PLAN.md (and nothing else) appeared
            if (stageAborted) {
              stageAborted = false
              send({ type: 'turnDone', steps: 0 }) // close the turn — the user cancelled; don't build
              break
            }
          }
          for await (const ev of s.submit(msg.text, msg.images)) {
            send(ev) // M11: images = attached data-URIs
            logEvent(ev)
          }
          sendTree() // the agent may have created/edited files — refresh the tree
          saveChat(msg.text) // M11: persist the turn to the active chat (+ title it from the first message)
          sendChats() // the title may have changed
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
            } else if (msg.action === 'write') {
              writeFile(dir, msg.path, msg.content) // M9/Code-pane save; Vite HMR reloads the preview
              send({ type: 'fileEdited', path: msg.path, ok: true })
              sendTree()
            } else if (msg.action === 'editText') {
              const ok = editJsxTextAtLoc(dir, msg.path, msg.line, msg.col, msg.text) // M9 inline text edit
              send({ type: 'fileEdited', path: msg.path, ok }) // ok:false ⇒ client falls back to an AI edit
            } else if (msg.action === 'setClass') {
              // M9 toolbar: write the new className. The live preview already reflects it; failure (dynamic
              // className) just surfaces a toast — don't fall back to AI here.
              if (!setClassAtLoc(dir, msg.path, msg.line, msg.col, msg.className)) send({ type: 'fileOpError', action: 'setClass', message: "Couldn't update styles — this element's className is dynamic." })
            } else if (msg.action === 'create' || msg.action === 'mkdir' || msg.action === 'rename' || msg.action === 'delete') {
              // M9 file-tree ops. On failure (e.g. name collision, traversal) surface a toast and keep the tree intact.
              try {
                if (msg.action === 'create') createFile(dir, msg.path)
                else if (msg.action === 'mkdir') makeDir(dir, msg.path)
                else if (msg.action === 'rename') renamePath(dir, msg.path, msg.to)
                else deletePath(dir, msg.path)
                sendTree() // a path appeared/moved/vanished → refresh the Code pane's tree
                if (msg.action === 'create') {
                  const { content, truncated } = readFile(dir, msg.path)
                  send({ type: 'fileContent', path: msg.path, content, truncated }) // open the new file
                }
              } catch (err) {
                send({ type: 'fileOpError', action: msg.action, message: (err as Error).message })
              }
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
            const dir = manager.dirOf(id)
            if (dir) ensureVisualEditConfig(dir) // M9: backfill the loc-stamp on projects scaffolded before it
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
        case 'chat': { // M11: multiple chats per project
          const dir = activeId && manager.dirOf(activeId)
          if (!dir || !chatStore || !active) break
          if (msg.action === 'list') sendChats()
          else if (msg.action === 'new') {
            // Already sitting on an empty chat? Reuse it — don't mint another "New chat" (they'd accumulate).
            if (activeChatId && active.getHistory().length === 0) {
              sendChats()
              break
            }
            saveChat() // snapshot the current chat before starting a fresh one
            active.reset()
            loadChat(chatStore.create(dir).id)
          } else if (msg.action === 'switch' && msg.id) {
            saveChat()
            loadChat(msg.id)
          } else if (msg.action === 'rename' && msg.id && msg.title) {
            chatStore.rename(dir, msg.id, msg.title)
            sendChats()
          } else if (msg.action === 'delete' && msg.id) {
            chatStore.delete(dir, msg.id)
            if (msg.id === activeChatId) loadChat(chatStore.list(dir)[0].id) // list() recreates one if none remain
            else sendChats()
          }
          break
        }
        case 'chats': { // the Chats page: every project's chat list (read-only — never creates/prunes)
          if (!chatStore) break
          const groups = manager
            .list()
            .map((project) => {
              const dir = manager.dirOf(project.id)
              return { project, chats: dir ? chatStore.peek(dir) : [] }
            })
            .filter((g) => g.chats.length > 0)
          send({ type: 'allChats', groups })
          break
        }
        case 'terminal': { // M7: open/close an interactive shell (one of possibly several sessions)
          if (!activeId) break
          if (msg.action === 'stop') {
            terms.get(msg.id)?.kill()
            terms.delete(msg.id)
            break
          }
          const sandbox = manager.sandboxOf(activeId)
          if (!(sandbox instanceof DockerSandbox)) {
            // No Docker ⇒ no shell to attach. Tell the client so the tab shows "exited" instead of a blank
            // xterm forever (the UI also disables New terminal when serverInfo.sandbox is false).
            send({ type: 'terminalExit', id: msg.id })
            break
          }
          terms.get(msg.id)?.kill() // replace if this id already had a shell
          const containerId = await sandbox.getContainerId()
          const sid = msg.id
          terms.set(
            sid,
            await createTerminal(
              containerId,
              { cols: msg.cols ?? 80, rows: msg.rows ?? 24 },
              (data) => send({ type: 'terminalData', id: sid, data }),
              () => {
                send({ type: 'terminalExit', id: sid })
                terms.delete(sid)
              },
            ),
          )
          break
        }
        case 'terminalInput':
          terms.get(msg.id)?.write(msg.data)
          break
        case 'terminalResize':
          terms.get(msg.id)?.resize(msg.cols, msg.rows)
          break
        case 'permission':
          ;(staging ?? active)?.respondPermission(msg.id, msg.decision)
          break
        case 'answer': // ADR-043: the user's answer to an AskUserQuestion → wakes the parked loop
          ;(staging ?? active)?.respondQuestion(msg.id, msg.answers)
          break
        case 'abort':
          if (staging) {
            stageAborted = true // cancel the whole submit — the builder must NOT start after a user abort
            staging.abort()
          }
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
    killAllTerms() // end the terminal shells (the container stays up)
    active = undefined
    activeId = undefined
  })
}

/** HTTP handler on the WS port: GET /token returns the per-run secret, CORS-restricted to allowed origins
 *  (so a cross-site page cannot READ it). Everything else is WebSocket-only. */
function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (req.method === 'GET' && (req.url ?? '').startsWith('/token')) {
    if (origin && ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ token: WS_TOKEN }))
    return
  }
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end('Upgrade Required: this is a WebSocket endpoint')
}

/** Validate the WS upgrade. Browser clients (always send Origin) must be an allowed origin AND present the
 *  token — this blocks Cross-Site WebSocket Hijacking. No-Origin clients (Node tests/CLI) are trusted local
 *  tooling and allowed without a token. */
function verifyWsClient(
  info: { origin?: string; req: IncomingMessage },
  cb: (ok: boolean, code?: number, message?: string) => void,
): void {
  const origin = info.origin ?? info.req.headers.origin
  if (!origin) return cb(true) // non-browser client — cannot be a CSWSH victim
  if (!ALLOWED_ORIGINS.has(origin)) return cb(false, 403, 'Forbidden origin')
  const token = new URL(info.req.url ?? '/', 'http://localhost').searchParams.get('token')
  return token === WS_TOKEN ? cb(true) : cb(false, 401, 'Invalid token')
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
  const chatStore = new ChatStore() // M11: multiple chats per project, persisted under each project's .cascade/
  // M7 security: an explicit http.Server so we can bind localhost, serve the token over CORS, and validate the
  // WS upgrade's Origin + token (see handleHttp / verifyWsClient).
  const httpServer = createServer(handleHttp)
  const wss = new WebSocketServer({ server: httpServer, verifyClient: verifyWsClient })
  wss.on('connection', (ws) => handleConnection(ws, manager, preview, previewProxy, PREVIEW_PORT, versions, chatStore, { sandbox: hasDocker, model: MODEL }))
  httpServer.listen(PORT, HOST)
  // Graceful exit (Ctrl-C / SIGTERM): dispose sessions + remove this run's sandbox containers. (A hard
  // SIGKILL skips this — the startup sweep above is the backstop.)
  const shutdown = () => void Promise.allSettled([manager.dispose(), sweepSandboxContainers()]).finally(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  console.log(
    `Cascade server listening on ws://${HOST}:${PORT}  (model: ${MODEL}, projects: ${PROJECTS_ROOT}, sandbox: ${hasDocker ? 'docker' : 'host'})`,
  )
  if (sandboxEnabled && !hasDocker)
    console.warn('⚠️  Docker not available — agent commands run on the HOST (no isolation). Install/start Docker Desktop for per-project sandboxing.')
}

// Run only when invoked directly (tsx src/wsServer.ts) — NOT when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start()
