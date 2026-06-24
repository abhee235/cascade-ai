// Drives the headless @cascade/core engine from the VS Code side and bridges it to the webview.
//
// This is the seam: the provider consumes a CascadeSession IN-PROCESS and forwards the engine's
// ActivityEvents to the webview via postMessage. In Phase 12 a WebSocket server will consume the
// SAME session and forward the SAME ActivityEvents to a browser — the engine doesn't know or care
// which frontend is attached. — ADR-018.
import * as vscode from 'vscode'
import { join } from 'node:path'
import {
  createSession,
  createProvider,
  JsonlTracer,
  type CascadeSession,
  type InboundMessage,
  type PermissionMode,
  type Tracer,
} from '@cascade/core'

export class CascadeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'cascade.view'

  private session?: CascadeSession
  private sessionCwd?: string

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    }
    view.webview.html = this.html(view.webview)

    view.webview.onDidReceiveMessage((msg: InboundMessage) =>
      this.onInbound(msg, view.webview),
    )
  }

  private getSession(): CascadeSession {
    // Recompute cwd each time: a workspace folder may be opened AFTER the first session was created.
    // Rebuild the session if cwd changed so tools resolve relative paths against the right root.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    if (!this.session || this.sessionCwd !== cwd) {
      const cfg = vscode.workspace.getConfiguration('cascade')
      const model = cfg.get<string>('model', 'qwen36-agentic:latest')
      // Build the provider from config (factory), then inject it into the session (DI). — ADR-020.
      const provider = createProvider({
        provider: cfg.get<string>('provider', 'ollama'),
        model,
        baseUrl: cfg.get<string>('baseUrl') || undefined,
        apiKey: cfg.get<string>('apiKey') || undefined,
      })
      // Permission MODE comes from settings (the frontend's policy — ADR-009). 'default' asks for writes.
      const mode = cfg.get<PermissionMode>('permissionMode', 'default')
      // Forensic trace (ADR-023): when cascade.trace is on, write a JSONL run log under <workspace>/.cascade/.
      let tracer: Tracer | undefined
      if (cfg.get<boolean>('trace', true)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        tracer = new JsonlTracer(join(cwd, '.cascade', `trace-${stamp}.jsonl`))
      }
      this.session = createSession({
        cwd,
        provider,
        model,
        mode,
        allow: cfg.get<string[]>('allowTools', []),
        deny: cfg.get<string[]>('denyTools', []),
        tracer,
      })
      this.sessionCwd = cwd
    }
    return this.session
  }

  private async onInbound(msg: InboundMessage, webview: vscode.Webview) {
    switch (msg.type) {
      case 'submit': {
        const session = this.getSession()
        for await (const event of session.submit(msg.text)) {
          webview.postMessage(event)
        }
        break
      }
      case 'permission':
        this.getSession().respondPermission(msg.id, msg.decision)
        break
      case 'reset':
        this.session?.reset()
        break
      case 'abort':
        this.session?.abort()
        break
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
