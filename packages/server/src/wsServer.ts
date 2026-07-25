// wsServer.ts — Cascade over WebSocket. (Phase 13.1 → 13.2)
//
// 13.1: each connection drove its own CascadeSession, and every ActivityEvent it yields is relayed back as
// JSON — the SAME protocol the VS Code extension uses in-process (ADR-018).
// 13.2: sessions are now owned by a server-wide ProjectManager and keyed by project. A connection ATTACHES
// to one project (its "active session") and routes submit/abort/etc to it; closing the socket detaches but
// does NOT dispose the session, so a project's conversation survives reconnects.
//
// Shape: a web server + a session relay decoupled from the transport.

import './loadDotEnv.js' // FIRST import: .env → process.env before the CASCADE_* consts below read it
import { dirname, join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CascadeSession, InboundMessage } from '@cascade/core'
import type { BuilderCommand } from '@cascade/app-protocol'
import { flushTracers, ProjectManager, setTraceSession } from './projectManager.js'
import { ensurePlanPersisted } from './planStage.js'
import { DockerSandbox, dockerAvailable, sweepSandboxContainers } from './dockerSandbox.js'
import { ensureVisualEditConfig, listTemplates } from './templates.js'
import { ChatStore } from './chatStore.js'
import { listModels, modelInfo, providerCatalog, setProviderKey } from './modelCaps.js'
import { activeModel, addEnabledModel, enabledModelsForClient, initModelRegistry, modelContextFor, modelEndpointFor, modelParamsFor, removeEnabledModel, setActiveModel, setModelContext, setModelParams } from './modelRegistry.js'
import { addMcpServer, enabledMcpServers, initMcpRegistry, mcpServers as mcpServersConfig, removeMcpServer, toggleMcpServer } from './mcpRegistry.js'
import { sdkConnect } from '@cascade/core'
import type { McpServerInfo } from '@cascade/app-protocol'
import type { ChatHistoryItem } from '@cascade/app-protocol'
import type { Message } from '@cascade/core'
import { createFile, deletePath, editJsxTextAtLoc, makeDir, readDiff, readFile, readTree, renamePath, setClassAtLoc, writeFile } from './fileService.js'
import { PreviewManager } from './previewManager.js'
import { PreviewProxy } from './previewProxy.js'
import { runCheck } from './checkProject.js'
import { VersionManager } from './versionManager.js'
import { createTerminal, type TerminalHandle } from './terminalSession.js'
import { liveTurn } from './liveTurn.js'

/** What a connection can receive: a core session message OR an app/builder command. */
type Inbound = InboundMessage | BuilderCommand

const PORT = Number(process.env.CASCADE_PORT ?? 4319)
const PREVIEW_PORT = Number(process.env.CASCADE_PREVIEW_PORT ?? 4320) // M5.2: stable preview-proxy origin
// Multi-provider (ADR-020 finally reaching the server): ollama stays the default; any OpenAI-compatible
// hosted backend works via CASCADE_PROVIDER (+ key in .env). Unknown ids need CASCADE_BASE_URL too.
const PROVIDER = (process.env.CASCADE_PROVIDER ?? 'ollama').toLowerCase()
// Per-provider default model: only where a safe universal default EXISTS. Hosted catalogs vary too much
// to guess (openrouter/nvidia ids are vendor-prefixed) — for those, requireModel() below fails fast.
const DEFAULT_MODELS: Record<string, string> = { ollama: 'qwen2.5-coder:latest', openai: 'gpt-5-mini' }
const MODEL = process.env.CASCADE_MODEL ?? DEFAULT_MODELS[PROVIDER] ?? ''
const BASE_URL = process.env.CASCADE_BASE_URL || undefined
// Compaction window override — mainly for hosted providers (no live probe): set this if your NIM/OpenRouter
// endpoint serves a different window than the model's native max in the model→window map. 0/unset ⇒ the map.
const CONTEXT_WINDOW = Number(process.env.CASCADE_CONTEXT_WINDOW) || undefined
// Compaction trigger fraction (core default 0.7). Hardware knob: on partial-offload boxes decode slows as
// context grows (measured 48→31 tok/s by 90k), so e.g. 0.5 keeps the working set in the fast range.
const COMPACT_RATIO = Number(process.env.CASCADE_COMPACT_RATIO) || undefined

// Fail fast at BOOT on obvious misconfiguration — a clear message here beats a cryptic HTTP 401/404
// twenty turns into a build. Key names mirror the factory's resolution (OPENAI_API_KEY etc. > CASCADE_API_KEY).
const KEY_VARS: Record<string, string> = { openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', nvidia: 'NVIDIA_API_KEY' }
if (!MODEL) {
  console.error(`CASCADE_PROVIDER=${PROVIDER} has no default model — set CASCADE_MODEL (e.g. in .env). Example for nvidia: CASCADE_MODEL=moonshotai/kimi-k2-instruct`)
  process.exit(1)
}
if (KEY_VARS[PROVIDER] && !process.env[KEY_VARS[PROVIDER]] && !process.env.CASCADE_API_KEY) {
  console.error(`Provider "${PROVIDER}" needs an API key: set ${KEY_VARS[PROVIDER]} (or CASCADE_API_KEY) in .env at the repo root.`)
  process.exit(1)
}
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
  // ADR-068: the SINGLE active turn lives in the server-wide `liveTurn` registry, NOT in this connection —
  // so a hard reload or a second tab still sees the build running and re-attaches to its stream.
  const sendTurnActivity = () => {
    const t = liveTurn.current
    send({ type: 'turnActivity', projectId: t?.projectId, chatId: t?.chatId, phase: t?.phase ?? null })
  }
  // On opening the project whose turn is live, replay the in-flight state that the persisted log doesn't hold.
  const reattachTurn = () => {
    const t = liveTurn.for(activeId)
    if (!t) return
    if (t.status) send({ type: 'status', text: t.status })
    if (t.streamThinking) send({ type: 'thinking_delta', thinking: t.streamThinking })
    if (t.streamText) send({ type: 'text_delta', text: t.streamText })
    if (t.pendingQuestion) send(t.pendingQuestion) // the parked card — still answerable (loop alive)
    sendTurnActivity()
  }
  // Hear the turn wherever it was started (this socket, a previous one that reloaded away, another tab):
  // its events when we're viewing that project, and every activity change regardless — the sidebar dot has
  // to appear on a project we're not looking at. Dropped on close, below.
  const unsubscribeTurn = liveTurn.subscribe((n) => {
    if (n.kind === 'activity') sendTurnActivity()
    else if (n.projectId === activeId) send(n.ev)
  })
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

  // Auto-start the live preview for a project IF it's buildable (node_modules populated) and nothing is
  // already tracked for it — so a finished build shows live without a manual Run. Called on project OPEN
  // (re-opening a built project) AND on build-TURN completion (the case that matters for a BRAND-NEW app:
  // at open time node_modules didn't exist yet, so only the first build's completion can flip this on).
  // A not-yet-installed project is skipped — auto-installing on every trigger would be too heavy. No-op if a
  // preview is already running/stopped (respects a manual Stop; HMR handles a rebuild that's already live).
  const maybeAutoStartPreview = async (projectId: string): Promise<void> => {
    if (!preview || preview.state(projectId)) return // nothing tracked yet ⇒ safe to auto-start
    const sandbox = manager.sandboxOf(projectId)
    if (!(sandbox instanceof DockerSandbox)) return
    const has = await sandbox.exec('[ -n "$(ls -A node_modules 2>/dev/null)" ] && echo yes || echo no').catch(() => ({ output: '', exitCode: 1 }))
    if (!has.output.includes('yes')) return
    const dir = manager.dirOf(projectId)
    if (dir) ensureVisualEditConfig(dir) // M9: backfill the loc-stamp on older scaffolds
    void preview.start(projectId, sandbox, (s) => {
      emitPreview(s)
      if (s.status === 'running') startTail(projectId)
    })
  }

  // Greet the new connection with capabilities + the project list + available templates so the UI can render
  // immediately (serverInfo drives the Terminal's Docker gate and the Settings page). ADR-067: model +
  // provider come from the manager (runtime-mutable), and the provider menu rides along for the picker.
  if (serverInfo) send({ type: 'serverInfo', sandbox: serverInfo.sandbox, model: manager.currentModel, provider: manager.currentProvider, providers: providerCatalog() })
  send({ type: 'projects', projects: manager.list(), activeId })
  sendTurnActivity() // a build may already be running from an earlier connection — say so up front, not on the next change
  send({ type: 'templates', templates: listTemplates() })
  // ADR-067: the curated model list for the picker (always includes the running model).
  const sendEnabledModels = () => send({ type: 'enabledModels', models: enabledModelsForClient({ provider: manager.currentProvider, model: manager.currentModel }) })
  sendEnabledModels()
  // ADR-071: the configured MCP servers + live connection status. env VALUES (API keys) are NEVER sent — only
  // their key NAMES — so a key set from the panel stays server-side, exactly like a model API key.
  const sendMcpServers = () => {
    const config = mcpServersConfig()
    const statuses = new Map(manager.mcpStatuses(activeId).map((s) => [s.name, s]))
    // url is the CLEAN endpoint (the key is stored separately), so it's safe to send and editable. The key
    // itself is never echoed — only `hasKey` (a boolean).
    const servers: McpServerInfo[] = Object.entries(config).map(([name, c]) => ({
      name,
      url: c.url,
      hasKey: !!c.apiKey,
      apiKeyIn: c.apiKeyIn,
      command: c.command, // a local stdio server, if hand-added; the web UI never creates these
      disabled: c.disabled,
      status: statuses.get(name)?.status,
      toolCount: statuses.get(name)?.toolNames.length,
      error: statuses.get(name)?.error,
    }))
    send({ type: 'mcpServers', servers })
  }
  sendMcpServers()

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
    // ADR-068: a RUNNING turn's history lives in the session — disk is stale until the turn ends (save()
    // only runs after the loop). Re-loading it here would hand the live session an EMPTY history mid-build,
    // silently discarding everything the agent has done so far. In-memory wins while the turn is in flight.
    const live = liveTurn.for(activeId)?.chatId === id
    if (!live) active.loadHistory(chatStore.messages(dir, id))
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
            // ADR-068: if a turn is STILL RUNNING for this project, land on ITS chat — a turn started after
            // this one (or a freshly created empty chat) would otherwise hide the build in progress. Passing
            // it as `keepId` also protects it from prune while it has no saved messages yet.
            const dir = activeId && manager.dirOf(activeId)
            const liveChat = liveTurn.for(activeId)?.chatId
            if (dir && chatStore) loadChat(liveChat || chatStore.list(dir, liveChat)[0].id)
            const pv = activeId && preview?.state(activeId) // re-show a preview already running for this project
            if (pv) {
              emitPreview(pv)
              if (pv.status === 'running' && activeId) startTail(activeId) // resume its Console logs
            } else if (activeId && !liveTurn.for(activeId)) {
              // Re-opening a built project: auto-start its preview (no-op if not yet buildable, or a build is
              // live and owns the dev server). The brand-new-app path is covered on turn completion instead.
              await maybeAutoStartPreview(activeId)
            }
            reattachTurn() // ADR-068: if this project's turn is live, replay its in-flight stream + parked card
          }
          break
        }
        // ADR-067: runtime provider/model switching — no server restart.
        case 'listModels': {
          send({ type: 'models', provider: msg.provider, models: await listModels(msg.provider, msg.baseUrl) })
          break
        }
        case 'modelInfo': {
          const info = await modelInfo(msg.provider, msg.model, msg.baseUrl)
          send({ type: 'modelInfo', provider: msg.provider, model: msg.model, capabilities: info.capabilities, contextWindow: info.contextWindow, limits: info.limits })
          break
        }
        case 'setApiKey': {
          setProviderKey(msg.provider, msg.key)
          // re-announce providers (configured status may have flipped)
          send({ type: 'serverInfo', sandbox: serverInfo?.sandbox ?? false, model: manager.currentModel, provider: manager.currentProvider, providers: providerCatalog() })
          break
        }
        case 'addModel': {
          addEnabledModel(msg.provider, msg.model, msg.contextWindow, msg.baseUrl, msg.apiKey, msg.api) // ADR-076/077: baseUrl+key+wire-protocol for a custom endpoint
          sendEnabledModels()
          break
        }
        case 'removeModel': {
          removeEnabledModel(msg.provider, msg.model)
          sendEnabledModels()
          break
        }
        case 'setModelContext': {
          setModelContext(msg.provider, msg.model, msg.contextWindow)
          sendEnabledModels()
          // if it's the active model, re-apply so the new window takes effect now
          if (manager.currentProvider === msg.provider && manager.currentModel === msg.model) {
            await manager.setModelConfig({ provider: msg.provider, model: msg.model, contextWindow: msg.contextWindow })
          }
          break
        }
        case 'setModelParams': {
          // ADR-067: merge the full editable param set (context/output/sampling) and persist it.
          setModelParams(msg.provider, msg.model, msg.params)
          sendEnabledModels()
          // Live-apply to the active model so tweaks take effect on the next turn without a re-switch.
          if (manager.currentProvider === msg.provider && manager.currentModel === msg.model) {
            await manager.setModelConfig({ provider: msg.provider, model: msg.model, ...modelParamsFor(msg.provider, msg.model) })
          }
          break
        }
        // ── ADR-071: MCP server management ───────────────────────────────────────────────────────────
        case 'listMcpServers':
          sendMcpServers()
          break
        case 'addMcpServer': {
          // Add OR edit. Key stored separately (apiKey/apiKeyIn), server-side, never echoed. apiKey OMITTED ⇒
          // keep the existing one (the "edit the host, keep the key" path — see mcpRegistry.addMcpServer).
          addMcpServer(msg.name, { url: msg.url, apiKey: msg.apiKey, apiKeyIn: msg.apiKeyIn, headers: msg.headers })
          await manager.invalidateSessions() // next open connects with the new config
          sendMcpServers()
          break
        }
        case 'removeMcpServer': {
          removeMcpServer(msg.name)
          await manager.invalidateSessions()
          sendMcpServers()
          break
        }
        case 'toggleMcpServer': {
          toggleMcpServer(msg.name, msg.disabled)
          await manager.invalidateSessions()
          sendMcpServers()
          break
        }
        case 'setModel': {
          // ADR-067/076: apply the target model's saved params (window/output/sampling) + its custom endpoint on
          // activation. baseUrl/apiKey come from the server-side registry (modelEndpointFor), NOT the client — the
          // browser never holds the key, and `setModel` needs only provider+model. msg.baseUrl is a fallback for
          // an ad-hoc switch that didn't go through addModel.
          const ep = modelEndpointFor(msg.provider, msg.model)
          await manager.setModelConfig({ provider: msg.provider, model: msg.model, baseUrl: ep.baseUrl ?? msg.baseUrl, apiKey: ep.apiKey, api: ep.api, ...modelParamsFor(msg.provider, msg.model) })
          setActiveModel({ provider: msg.provider, model: msg.model, baseUrl: ep.baseUrl ?? msg.baseUrl }) // survive a restart (see boot restore)
          // The switch dropped every cached session; rebuild the active one and reload its history so the
          // conversation continues under the new provider. Then re-announce the active model.
          if (activeId) {
            active = manager.open(activeId)
            if (activeChatId) loadChat(activeChatId)
          }
          send({ type: 'serverInfo', sandbox: serverInfo?.sandbox ?? false, model: manager.currentModel, provider: manager.currentProvider, providers: providerCatalog() })
          break
        }
        case 'submit': {
          const s = requireActive()
          if (!s) break
          // ADR-068: pin this turn's project/chat so its logging + save can't be misrouted if the user browses
          // to another project mid-build. Also seed the live snapshot for re-attach.
          const turnProjectId = activeId!
          const turnChatId = activeChatId ?? ''
          const turnDir = manager.dirOf(turnProjectId)
          const pinnedLog = (entry: import('@cascade/app-protocol').ChatReplayEntry) => {
            if (turnDir && chatStore && turnChatId) chatStore.appendEvent(turnDir, turnChatId, entry)
          }
          // ADR-053: group this turn's spans under the chat it belongs to, BEFORE anything is traced — the
          // plan stage builds its tracer partway through this handler and must inherit the same session.
          if (turnDir) setTraceSession(turnDir, turnChatId || undefined)
          const turn = liveTurn.start(turnProjectId, turnChatId)
          // relay: fold into the live snapshot (for perfect re-attach) + flip phase on approval + fan out to
          // every attached connection viewing this project (including this one) + log. Note it does NOT write
          // to this socket directly — the turn is not ours to own; whoever is watching gets it.
          const relay = (ev: { type: string; [k: string]: unknown }) => {
            liveTurn.publish(turn, ev)
            if (REPLAY_TYPES.has(ev.type)) pinnedLog({ event: ev })
          }

          // ADR-056 rung 3: first message of a fresh, unplanned project → run the planner as its own
          // top-level session FIRST (deterministic). Its events (incl. AskUserQuestion) stream on the same
          // pipe; its turnDone is swallowed so the UI sees ONE turn.
          pinnedLog({ user: msg.text }) // the user row of the replay, FIRST — matching the live optimistic render
          const planner = activeId ? manager.planSessionFor(activeId) : undefined
          try {
            if (planner) {
              staging = planner
              relay({ type: 'status', text: 'Planning first — writing PLAN.md…' })
              try {
                for await (const ev of planner.submit(msg.text)) {
                  if (ev.type === 'turnDone') continue
                  relay(ev)
                }
              } finally {
                staging = undefined
                if (turnDir) ensurePlanPersisted(turnDir, planner) // guarantee PLAN.md
                await planner.dispose().catch(() => {})
              }
              sendTree() // PLAN.md (and nothing else) appeared
              if (stageAborted) {
                stageAborted = false
                send({ type: 'turnDone', steps: 0 }) // close the turn — the user cancelled; don't build
                break
              }
            }
            // Fresh projects ship an EMPTY node_modules (only the preview installs, on Run) — so the agent's
            // first `npm run build` would hit `tsc: not found`, and a weak model stalls asking to install
            // (measured: gpt-oss:20b). Install ONCE here, before the build, so the agent always inherits a
            // build-ready project. No-op after the first install (node_modules populated).
            const buildSandbox = manager.sandboxOf(turnProjectId)
            if (buildSandbox instanceof DockerSandbox) {
              const dep = await buildSandbox.exec('[ -n "$(ls -A node_modules 2>/dev/null)" ] && echo yes || echo no').catch(() => ({ output: 'yes', exitCode: 0 }))
              if (!dep.output.includes('yes')) {
                relay({ type: 'status', text: 'Installing dependencies…' })
                await buildSandbox.exec('npm install --no-audit --no-fund').catch(() => {})
              }
            }
            for await (const ev of s.submit(msg.text, msg.images)) relay(ev) // M11: images = attached data-URIs
          } finally {
            liveTurn.end(turn) // turn over (or aborted) — clears the dot + composer lock everywhere
            // The build just populated node_modules (brand-new app) and/or changed files — auto-start the
            // preview so a finished build shows live without a manual Run. No-op if already running or the
            // turn aborted before install (not yet buildable). This is the trigger that covers a NEW app,
            // whose project was opened before node_modules existed.
            void maybeAutoStartPreview(turnProjectId)
          }
          sendTree() // the agent may have created/edited files — refresh the tree
          if (turnDir && chatStore) chatStore.save(turnDir, turnChatId, s.getHistory(), msg.text) // pinned save
          sendChats() // the title may have changed
          // M6: checkpoint the turn's file changes (no-op if nothing changed), then refresh the history.
          const dir = turnDir
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
    unsubscribeTurn() // stop hearing the turn — it keeps running, and the next connection re-attaches
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

  initModelRegistry(PROJECTS_ROOT) // ADR-067: curated model list persisted under PROJECTS_ROOT/.cascade/
  initMcpRegistry(PROJECTS_ROOT) // ADR-071: configured MCP servers persisted under PROJECTS_ROOT/.cascade/mcp.json
  const manager = new ProjectManager({
    root: PROJECTS_ROOT,
    provider: PROVIDER,
    model: MODEL,
    baseUrl: BASE_URL,
    contextWindow: CONTEXT_WINDOW,
    compactRatio: COMPACT_RATIO,
    sandboxFor,
    // ADR-071: a thunk so each new session reads the CURRENT enabled set (after add/remove/toggle + invalidate).
    mcpServers: enabledMcpServers,
    mcpConnect: sdkConnect,
  })
  // ADR-067: restore the model the user last SELECTED. The env vars are the first-run default, not a
  // standing override — otherwise every restart silently moved the session back to CASCADE_MODEL (measured:
  // a chosen local Ollama model reverted to a paid hosted one, with only a small label to give it away).
  const restored = activeModel()
  if (restored) {
    // ADR-076: re-apply the saved custom endpoint's key too, so a remote GPU keeps working across restarts.
    const ep = modelEndpointFor(restored.provider, restored.model)
    await manager.setModelConfig({ provider: restored.provider, model: restored.model, baseUrl: ep.baseUrl ?? restored.baseUrl, apiKey: ep.apiKey, api: ep.api, ...modelParamsFor(restored.provider, restored.model) })
  }
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
  // flushTracers FIRST: the exporter batches, so the spans describing whatever we're about to tear down are
  // still in memory — exiting without it loses the tail of every session (and `tsx watch` restarts often).
  const shutdown = () => void flushTracers().finally(() => Promise.allSettled([manager.dispose(), sweepSandboxContainers()]).finally(() => process.exit(0)))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // A CRASH must leave evidence. Measured 2026-07-23: a build stopped dead mid-turn, and the cause was
  // unknowable afterwards — the trace ends at the last event the loop managed to write, the viewer shows a
  // turn that simply stops, and the stack went to a console window that scrolls away and is never kept. We
  // instrumented the agent thoroughly and left the process that runs it completely unobservable. Node exits
  // on an unhandled rejection by default, so both hooks below are real exit paths, not hypotheticals.
  const crashLog = join(PROJECTS_ROOT, '.cascade', 'server-crash.log')
  const recordCrash = (kind: string, err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    const entry = `\n[${new Date().toISOString()}] ${kind}\n${detail}\n`
    try {
      mkdirSync(dirname(crashLog), { recursive: true })
      appendFileSync(crashLog, entry)
    } catch {
      /* best-effort: if we can't write, the console line below is still better than silence */
    }
    console.error(`💥 ${kind} — recorded to ${crashLog}\n${detail}`)
    // Flush whatever spans are buffered, and close the open turn so the viewer shows it as interrupted
    // rather than losing it, then exit non-zero so the watcher/supervisor treats it as a failure.
    void flushTracers(1_000).finally(() => process.exit(1))
  }
  process.on('uncaughtException', (err) => recordCrash('uncaughtException', err))
  process.on('unhandledRejection', (reason) => recordCrash('unhandledRejection', reason))
  console.log(
    // Report the ACTIVE model (restored selection, or the env default) — not the env vars, which are only
    // the first-run seed. A boot line that names a model you aren't running is worse than none.
    `Cascade server listening on ws://${HOST}:${PORT}  (provider: ${manager.currentProvider}, model: ${manager.currentModel}${restored ? ' [restored selection]' : ''}, projects: ${PROJECTS_ROOT}, sandbox: ${hasDocker ? 'docker' : 'host'})`,
  )
  if (sandboxEnabled && !hasDocker)
    console.warn('⚠️  Docker not available — agent commands run on the HOST (no isolation). Install/start Docker Desktop for per-project sandboxing.')
}

// Run only when invoked directly (tsx src/wsServer.ts) — NOT when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start()
