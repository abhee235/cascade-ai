// Drives the headless @cascade/core engine from the VS Code side and bridges it to the webview.
//
// This is the seam: the provider consumes a CascadeSession IN-PROCESS and forwards the engine's
// ActivityEvents to the webview via postMessage. In Phase 12 a WebSocket server will consume the
// SAME session and forward the SAME ActivityEvents to a browser — the engine doesn't know or care
// which frontend is attached. — ADR-018.
import * as vscode from 'vscode'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  createSession,
  createProvider,
  JsonlTracer,
  loadSkills,
  makeSdkConnect,
  loadMcpServers,
  type CascadeSession,
  type InboundMessage,
  type McpServerConfig,
  type PermissionMode,
  type Tracer,
} from '@cascade/core'
import { createBrowserTool } from './browserTool'
import { ChatStore, historyToItems, newChatId } from './chatStore'
import { BASE_URLS, isOllamaLike, keyFor, listOllamaModels, ollamaModelInfo } from './modelManager'
import { ModelRegistry, type EnabledModel } from './modelRegistry'
import { openModelsPanel } from './modelsPanel'

/** The settings the model manager edits — one key each in the `cascade.*` namespace. */
type ModelConfigPatch = Partial<{
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  utilityModel: string
  permissionMode: string
  contextWindow: number
  maxOutputTokens: number
  temperature: number
  topP: number
  topK: number
}>

/** Extension-local additions to the wire (same precedent as the server's BuilderCommand — frontend-host
 *  concerns like chat management and user-invoked skills never enter the core engine protocol). */
type HostMessage =
  | InboundMessage
  | { type: 'skills' } // → skillsData reply (for the / menu)
  | { type: 'runSkill'; name: string; args?: string } // user typed /<skill> [args]
  | { type: 'chats' } // → chatsData + chatRestored replies (webview mount)
  | { type: 'chatSwitch'; id: string }
  | { type: 'chatDelete'; id: string }
  | { type: 'models' } // → modelsData reply (open/refresh the model manager)
  | { type: 'setModelConfig'; patch: ModelConfigPatch }
  | { type: 'activateModel'; provider: string; model: string } // pick from the curated list (applies its params)
  | { type: 'openSettings' } // native VS Code Settings tab filtered to cascade.* (the common pattern)
  | { type: 'openModelsPanel' } // the Language Models editor-area panel
  | { type: 'hello' } // webview loaded → host replies hostInfo (webview-initiated: a host-initiated post can be dropped while the page is still loading)

// Baked in by esbuild `define` — the bundle's build time, used for the stale-host handshake.
declare const __CASCADE_BUILD__: string

export class CascadeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'cascade.view'

  /** The feedback loop: everything the host does is visible in Output → "Cascade". */
  private readonly log = vscode.window.createOutputChannel('Cascade')

  /** The curated ENABLED models (ADR-067) — what the composer dropdown lists, across providers.
   *  Assigned in the constructor: field initializers run before `context` is bound. */
  private readonly registry: ModelRegistry

  /** Activate a curated model: write provider/model + its saved params to settings, so the session
   *  rebuild (config-change listener) picks the whole configuration up on the next turn — the same
   *  "apply params on switch" behavior the web server has. */
  private async activateModel(provider: string, model: string): Promise<void> {
    const p = this.registry.paramsFor(provider, model)
    const patch: Record<string, unknown> = { provider, model }
    // Only write params the user actually set for this model; leave the rest of the settings alone.
    if (p.baseUrl !== undefined) patch.baseUrl = p.baseUrl ?? ''
    if (p.contextWindow !== undefined) patch.contextWindow = p.contextWindow
    if (p.maxOutputTokens !== undefined) patch.maxOutputTokens = p.maxOutputTokens
    if (p.temperature !== undefined) patch.temperature = p.temperature
    if (p.topP !== undefined) patch.topP = p.topP
    if (p.topK !== undefined) patch.topK = p.topK
    await this.applyModelPatch(patch)
    this.log.appendLine(`[${new Date().toISOString()}] active model → ${provider}/${model}`)
  }

  /** API keys live in VS Code SecretStorage (encrypted, per-machine, NEVER synced or written to any
   *  file) — the usual pattern. Cached here so synchronous paths (session build) can read them; the
   *  cache is loaded before any message is handled and updated on every set/clear. */
  private readonly secretCache = new Map<string, string>()
  private secretsLoaded: Promise<void> | undefined
  private ensureSecrets(): Promise<void> {
    this.secretsLoaded ??= (async () => {
      for (const provider of Object.keys(BASE_URLS)) {
        const v = await this.context.secrets.get(`cascade.apiKey.${provider}`)
        if (v) this.secretCache.set(provider, v)
      }
    })()
    return this.secretsLoaded
  }

  /** Prompt for + store a provider's API key (empty input cancels; the literal "clear" removes it). */
  private async promptForKey(provider: string): Promise<void> {
    const existing = this.secretCache.get(provider)
    const value = await vscode.window.showInputBox({
      title: `${provider} API key`,
      prompt: existing ? 'A key is stored (encrypted). Enter a new one, or type "clear" to remove it.' : 'Stored ENCRYPTED in VS Code Secret Storage — never synced, never written to settings.',
      password: true,
      ignoreFocusOut: true,
    })
    if (value === undefined || value === '') return // cancelled
    if (value.trim().toLowerCase() === 'clear') {
      await this.context.secrets.delete(`cascade.apiKey.${provider}`)
      this.secretCache.delete(provider)
      this.log.appendLine(`[${new Date().toISOString()}] API key cleared for ${provider}`)
    } else {
      await this.context.secrets.store(`cascade.apiKey.${provider}`, value.trim())
      this.secretCache.set(provider, value.trim())
      this.log.appendLine(`[${new Date().toISOString()}] API key stored for ${provider} (secret storage)`)
    }
    this.configDirty = true // a key change must rebuild the session's provider on the next turn
  }

  private session?: CascadeSession
  private sessionCwd?: string
  /** The attached sidebar webview (for pushes triggered outside its own message flow, e.g. the panel). */
  private view?: vscode.WebviewView
  // Chat persistence (resume-a-previous-chat): the active chat id + the per-workspace store.
  private chatStore?: ChatStore
  private activeChatId = newChatId()
  // Skills loaded for this session — served to the / menu and injected on /<skill> invocation.
  private skills: { name: string; description: string; body: string }[] = []
  // A cascade.* setting changed since the session was built. The rebuild is DEFERRED to the next
  // getSession() while idle — tearing the session down mid-turn would kill the in-flight stream.
  private configDirty = false
  // One turn at a time: a second submit while streaming would start a concurrent loop and clobber
  // core's single inFlight abort controller (Stop would then only cancel the newest turn).
  private running = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.registry = new ModelRegistry(context.globalState)
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cascade')) this.configDirty = true
      }),
    )
  }

  /** Tear down MCP subprocesses and run end-of-session memory curation on window close. */
  dispose(): Promise<void> {
    this.saveActiveChat() // the transcript survives the window
    const s = this.session
    this.session = undefined
    return s?.dispose() ?? Promise.resolve()
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    }
    view.webview.html = this.html(view.webview)

    this.log.appendLine(`[${new Date().toISOString()}] webview attached — host build ${__CASCADE_BUILD__}`)

    view.webview.onDidReceiveMessage(async (msg: HostMessage) => {
      this.log.appendLine(`[${new Date().toISOString()}] ← ${msg.type}`)
      try {
        await this.ensureSecrets() // keys are loaded before ANY handler can build a session
        await this.onInbound(msg, view.webview)
      } catch (err) {
        // NOTHING may die silently: log it AND surface it in the transcript.
        const text = `⚠ ${msg.type} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
        this.log.appendLine(text)
        void view.webview.postMessage({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: text.split('\n')[0] }] } })
      }
    })
  }

  private getSession(): CascadeSession {
    // Recompute cwd each time: a workspace folder may be opened AFTER the first session was created.
    // Rebuild the session if cwd changed (tools resolve relative paths against the root) or settings
    // changed while idle. Never rebuild mid-turn — `running` guards that at the submit site.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    if (!this.session || this.sessionCwd !== cwd || (this.configDirty && !this.running)) {
      this.configDirty = false
      // A settings change in the SAME workspace keeps the conversation (a model switch mid-chat should
      // not wipe the transcript — the new session continues the history). A cwd change starts fresh.
      const carryHistory = this.sessionCwd === cwd ? this.session?.getHistory() : undefined
      void this.session?.dispose() // tear down the old session's MCP subprocesses before replacing it
      const cfg = vscode.workspace.getConfiguration('cascade')
      const model = cfg.get<string>('model', 'qwen36-agentic:latest')
      // A number setting where the sentinel means "not set — use the provider/backend default".
      const num = (key: string, unset: number): number | undefined => {
        const v = cfg.get<number>(key, unset)
        return v === unset ? undefined : v
      }
      const skillDirs = [
        join(this.context.extensionUri.fsPath, 'skills'),
        join(homedir(), '.cascade', 'skills'),
        join(cwd, '.cascade', 'skills'),
      ]
      // Build the provider from config (factory), then inject it into the session (DI). — ADR-020.
      // Key precedence: SecretStorage (panel) → cascade.apiKey setting → env vars (keyFor).
      const providerId = cfg.get<string>('provider', 'ollama')
      const resolvedKey = keyFor(providerId, cfg.get<string>('apiKey'), this.secretCache.get(providerId))
      const provider = createProvider({
        provider: providerId,
        model,
        baseUrl: cfg.get<string>('baseUrl') || undefined,
        apiKey: resolvedKey,
      })
      // Permission MODE comes from settings (the frontend's policy — ADR-009). 'default' asks for writes.
      const mode = cfg.get<PermissionMode>('permissionMode', 'default')
      // Forensic trace (ADR-023): when cascade.trace is on, write a JSONL run log under <workspace>/.cascade/.
      let tracer: Tracer | undefined
      if (cfg.get<boolean>('trace', true)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        tracer = new JsonlTracer(join(cwd, '.cascade', `trace-${stamp}.jsonl`))
      }
      // MCP servers from the portable project file <workspace>/.mcp.json (primary), with the optional
      // cascade.mcpServers VS Code setting merged underneath. Connected in the background (ADR-014).
      const mcpServers: Record<string, McpServerConfig> = {
        ...cfg.get<Record<string, McpServerConfig>>('mcpServers', {}),
        ...loadMcpServers(cwd),
      }
      this.session = createSession({
        cwd,
        provider,
        model,
        mode,
        allow: cfg.get<string[]>('allowTools', []),
        deny: cfg.get<string[]>('denyTools', []),
        tracer,
        mcpServers,
        // Extension trust posture: the user's own machine, user-authored .mcp.json — stdio (npx) MCP
        // servers are allowed, as in any local CLI agent. The web server keeps the locked-down default.
        mcpConnect: makeSdkConnect({ allowStdio: true }),
        embedModel: cfg.get<string>('embedModel') || undefined,
        autoMemory: cfg.get<boolean>('autoMemory', false),
        checkCommand: cfg.get<string>('checkCommand') || undefined, // ADR-051: workspace-declared "done" check

        contextWindow: cfg.get<number>('contextWindow') || undefined,
        compactRatio: cfg.get<number>('compactRatio') || undefined,
        keepRecentRatio: cfg.get<number>('keepRecentRatio') || undefined,

        // ADR-078: compaction economics. 'auto' lets core detect (native Ollama ⇒ constrained deep
        // compaction; hosted APIs ⇒ stop-at-auto).
        compactEconomics: (() => {
          const v = cfg.get<string>('compactEconomics', 'auto')
          return v === 'hosted' || v === 'constrained' ? v : undefined
        })(),
        // ADR-039/067: output cap (sizes the compaction summary reserve) + per-model sampling.
        // 0 = AUTO: derive a cap from the resolved window (window/8, floored 2k, capped by the model's spec
        // and 16k). Local backends usually declare no num_predict, which means "generate until the context
        // fills" — an unbounded ceiling is what let a degeneration spiral run for 186s.
        maxOutputTokens: cfg.get<number>('maxOutputTokens') || 'auto',
        temperature: num('temperature', -1),
        topP: num('topP', -1),
        topK: cfg.get<number>('topK') || undefined,
        // A real coding task needs far more than the chat default of 10 model round-trips.
        maxTurns: cfg.get<number>('maxTurns') || undefined,
        // ADR-055/056: skills + named agents. Order = shadowing order: extension-BUNDLED skills first
        // (immutable base, e.g. new-app — a lazily-loaded playbook instead of
        // always-on prompt text), then global (~/.cascade), then workspace (.cascade), which shadows all.
        skillDirs,
        // Small co-resident model for side-queries (compaction summaries, memory curation) so they don't
        // evict the builder model's KV cache. Same provider/endpoint, different model id. Empty = off.
        utility: (() => {
          const um = cfg.get<string>('utilityModel', '').trim()
          if (!um) return undefined
          return {
            provider: createProvider({
              provider: providerId,
              model: um,
              baseUrl: cfg.get<string>('baseUrl') || undefined,
              apiKey: resolvedKey,
            }),
            model: um,
          }
        })(),
        agentDirs: [join(homedir(), '.cascade', 'agents'), join(cwd, '.cascade', 'agents')],
        // ADR-056 rung 5: workspace-relative files pinned into the system prompt, re-read each turn.
        contextFiles: cfg
          .get<string[]>('contextFiles', [])
          .map((p) => join(cwd, p)),
        // Local path model: a file outside the workspace is APPROVABLE (the gate asks) rather than refused,
        // and `additionalDirectories` widens the no-prompt area (extra trusted roots). The sandboxed web
        // builder keeps the hard jail — this is a frontend trust declaration, like stdio MCP.
        pathAccess: 'prompt',
        additionalDirectories: [
          ...cfg.get<string[]>('additionalDirectories', []),
          // Other folders of a multi-root workspace are in-scope by definition.
          ...(vscode.workspace.workspaceFolders ?? []).slice(1).map((f) => f.uri.fsPath),
        ],
        // The Browser tool (ADR-060/079, extension flavor): the model starts its own dev server via
        // Bash, opens it by URL, and MUST audit before claiming done. Registered unconditionally —
        // snapshot/probe/audit are text ops any model can use; screenshots need a vision model.
        extraTools: [createBrowserTool()],
      })
      if (carryHistory?.length) this.session.loadHistory(carryHistory)
      // Skills for the / menu + /<skill> injection (same dirs/shadowing the session itself loads).
      this.skills = loadSkills(skillDirs).map((s) => ({ name: s.name, description: s.description, body: s.body }))
      // Chat persistence: a FRESH session (new workspace, not a settings rebuild) resumes the most
      // recent chat — resume-by-default. A settings rebuild already carried history.
      this.chatStore = new ChatStore(cwd)
      if (!carryHistory?.length) {
        const recent = this.chatStore.list()[0]
        if (recent) {
          this.session.loadHistory(this.chatStore.load(recent.id))
          this.activeChatId = recent.id
        } else {
          this.activeChatId = newChatId()
        }
      }
      this.sessionCwd = cwd
    }
    return this.session
  }

  /** Persist the active chat's history (called after every turn and on teardown). Best-effort. */
  private saveActiveChat(): void {
    try {
      const history = this.session?.getHistory()
      if (history?.length && this.chatStore) this.chatStore.save(this.activeChatId, history)
    } catch {
      /* persistence must never break a turn */
    }
  }

  /** Open the Language Models editor panel. Public — also bound to the `cascade.openModels` command so it
   *  works from the command palette even if the sidebar webview is wedged. */
  openModels(): void {
    void this.ensureSecrets().then(() =>
      openModelsPanel({
        getSettings: () => {
          const cfg = vscode.workspace.getConfiguration('cascade')
          return {
            provider: cfg.get<string>('provider', 'ollama'),
            model: cfg.get<string>('model', ''),
            baseUrl: cfg.get<string>('baseUrl', ''),
            utilityModel: cfg.get<string>('utilityModel', ''),
            apiKey: cfg.get<string>('apiKey', ''),
            secrets: this.secretCache,
          }
        },
        apply: async (patch) => {
          await this.applyModelPatch(patch)
          if (this.view) await this.postModels(this.view.webview) // keep the composer chip/dropdown in sync
        },
        setKey: (provider) => this.promptForKey(provider),
        enabled: () => {
          const cfg = vscode.workspace.getConfiguration('cascade')
          return this.registry.list({ provider: cfg.get<string>('provider', 'ollama'), model: cfg.get<string>('model', '') })
        },
        addModel: async (provider, model, contextWindow) => {
          await this.registry.add({ provider, model, contextWindow })
          if (this.view) await this.postModels(this.view.webview)
        },
        removeModel: async (provider, model) => {
          await this.registry.remove(provider, model)
          if (this.view) await this.postModels(this.view.webview)
        },
        activate: async (provider, model) => {
          await this.activateModel(provider, model)
          if (this.view) await this.postModels(this.view.webview)
        },
      }),
    )
  }

  /** Write a settings patch to the right target: the workspace value if one exists there, else the user
   *  (global) value — the manager must never silently shadow a workspace config. The config-change
   *  listener marks the session dirty; the NEXT turn rebuilds with history carried over. */
  private async applyModelPatch(patch: Record<string, unknown>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('cascade')
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      const insp = cfg.inspect(key)
      const target = insp?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
      await cfg.update(key, value, target)
    }
  }

  /** Model manager snapshot: current settings + the live catalog/info for Ollama-like providers. */
  private async postModels(webview: vscode.Webview): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('cascade')
    const provider = cfg.get<string>('provider', 'ollama')
    const model = cfg.get<string>('model', '')
    const baseUrl = cfg.get<string>('baseUrl', '')
    const settings = {
      provider,
      model,
      baseUrl,
      apiKeySet: !!cfg.get<string>('apiKey', ''),
      utilityModel: cfg.get<string>('utilityModel', ''),
      permissionMode: cfg.get<string>('permissionMode', 'default'),
      contextWindow: cfg.get<number>('contextWindow', 0),
      maxOutputTokens: cfg.get<number>('maxOutputTokens', 0),
      temperature: cfg.get<number>('temperature', -1),
      topP: cfg.get<number>('topP', -1),
      topK: cfg.get<number>('topK', 0),
    }
    // The composer dropdown lists the CURATED enabled models (ADR-067) — across providers — never a
    // raw provider catalog. `ensure` keeps the running model visible even if it was removed from the list.
    const enabled = this.registry.list({ provider, model })
    // The reply must ALWAYS go out — a thrown fetch would otherwise leave the UI waiting forever.
    let info: Awaited<ReturnType<typeof ollamaModelInfo>> | undefined
    let error: string | undefined
    try {
      if (isOllamaLike(provider) && model) info = await ollamaModelInfo(model, baseUrl)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    webview.postMessage({ type: 'modelsData', settings, enabled, info, error })
  }

  /** Send the chat list + the active chat's rendered transcript to the webview. */
  private postChats(webview: vscode.Webview): void {
    const session = this.getSession()
    webview.postMessage({ type: 'chatsData', chats: this.chatStore?.list() ?? [], activeId: this.activeChatId })
    webview.postMessage({ type: 'chatRestored', items: historyToItems(session.getHistory()) })
  }

  /** One turn: stream the session's events to the webview, then persist. Used by submit AND /<skill>. */
  private async runTurn(text: string, images: string[] | undefined, webview: vscode.Webview): Promise<void> {
    if (this.running) return // one turn at a time — the composer shows Stop while busy
    // Resolve the session BEFORE taking the running flag: the dirty-config rebuild is gated on
    // `!running`, so taking the flag first would make a pending model/provider switch silently
    // NOT apply to this turn (measured: switched to openai, Send still hit the old ollama session).
    const session = this.getSession()
    this.running = true
    try {
      for await (const event of session.submit(text, images)) {
        webview.postMessage(event)
      }
    } catch (err) {
      // Surface the failure IN the transcript (a bad provider config used to be swallowed silently
      // by VS Code) and unlock the composer with the only "finished" signal the UI trusts.
      const msg = `⚠ ${err instanceof Error ? err.message : String(err)}`
      webview.postMessage({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: msg }] } })
      webview.postMessage({ type: 'turnDone', steps: 0 })
    } finally {
      this.running = false
      this.saveActiveChat()
    }
  }

  private async onInbound(msg: HostMessage, webview: vscode.Webview) {
    switch (msg.type) {
      case 'hello':
        // Stale-host handshake, webview-INITIATED so it can never race the page load: the webview asks
        // once its listener is attached; the host answers with its baked-in build stamp.
        webview.postMessage({ type: 'hostInfo', build: __CASCADE_BUILD__ })
        break
      case 'submit':
        await this.runTurn(msg.text, msg.images, webview)
        break
      case 'permission':
        this.getSession().respondPermission(msg.id, msg.decision)
        break
      case 'answer':
        // ADR-043: the user's answer to an AskUserQuestion — wakes the parked loop.
        this.getSession().respondQuestion(msg.id, msg.answers)
        break
      case 'reset':
        // "New chat": persist the old conversation, rotate to a fresh id — never destroy history.
        this.saveActiveChat()
        this.session?.reset()
        this.activeChatId = newChatId()
        this.postChats(webview)
        break
      case 'chats':
        this.postChats(webview)
        break
      case 'chatSwitch': {
        if (this.running) break // switching mid-turn would clobber the streaming history
        this.saveActiveChat()
        const session = this.getSession()
        session.loadHistory(this.chatStore?.load(msg.id) ?? [])
        this.activeChatId = msg.id
        this.postChats(webview)
        break
      }
      case 'chatDelete': {
        this.chatStore?.delete(msg.id)
        if (msg.id === this.activeChatId && !this.running) {
          this.getSession().reset()
          this.activeChatId = newChatId()
        }
        this.postChats(webview)
        break
      }
      case 'skills':
        webview.postMessage({ type: 'skillsData', skills: this.skills.map(({ name, description }) => ({ name, description })) })
        break
      case 'models':
        await this.postModels(webview)
        break
      case 'openSettings':
        // The REAL VS Code settings editor, scoped to our settings — native UI in the editor area.
        void vscode.commands.executeCommand('workbench.action.openSettings', 'cascade.')
        break
      case 'setModelConfig':
        await this.applyModelPatch(msg.patch)
        await this.postModels(webview)
        break
      case 'activateModel':
        await this.activateModel(msg.provider, msg.model)
        await this.postModels(webview)
        break
      case 'openModelsPanel':
        this.openModels()
        break
      case 'runSkill': {
        // User-invoked skill (the /<skill> slash pattern): inject the playbook DETERMINISTICALLY
        // instead of hoping the model calls the Skill tool.
        this.getSession() // ensure skills are loaded
        const skill = this.skills.find((s) => s.name === msg.name)
        if (!skill) break
        const args = msg.args?.trim()
        const text = `${args ? `${args}\n\n` : ''}Follow this workflow skill now${args ? ' for the request above' : ' for the current task'}:\n\n<skill name="${skill.name}">\n${skill.body}\n</skill>`
        await this.runTurn(text, undefined, webview)
        break
      }
      case 'abort':
        this.session?.abort()
        break
      case 'mcp': {
        // /mcp panel: run the requested action, then post the fresh status list back to the webview.
        const session = this.getSession() // ensures the hub exists + has started connecting
        if (msg.action === 'connect' && msg.server) session.mcpConnect(msg.server)
        else if (msg.action === 'disconnect' && msg.server) await session.mcpDisconnect(msg.server)
        webview.postMessage({ type: 'mcpStatus', servers: session.mcpStatuses() })
        break
      }
      case 'memoryView': {
        // /memory panel: optional action (search/forget), then post the current core + archival memory back.
        const session = this.getSession()
        if (msg.action === 'forget' && msg.id) session.memoryForget(msg.id)
        const hits = msg.action === 'search' && msg.query ? await session.memorySearch(msg.query) : undefined
        const view = session.memoryView()
        webview.postMessage({ type: 'memoryData', core: view.core, archival: view.archival, hits })
        break
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    )
    const katexUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'katex.css'),
    )
    const nonce = makeNonce()
    // CSP widens per Streamdown plugin: img/blob for Mermaid SVGs, font-src data: for KaTeX's
    // inlined fonts, 'wasm-unsafe-eval' for Shiki (Phase 4). Styles come from our compiled CSS.
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource} data:`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <link rel="stylesheet" href="${katexUri}" />
  <title>Cascade</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}
