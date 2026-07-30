// VS Code extension entry (the frontend host wiring).
import * as vscode from 'vscode'
import { CascadeViewProvider } from './CascadeViewProvider'

let provider: CascadeViewProvider | undefined

export function activate(context: vscode.ExtensionContext) {
  provider = new CascadeViewProvider(context)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CascadeViewProvider.viewId, provider),
    // Palette + view-title entry point for the Language Models panel — independent of the sidebar
    // webview, so it works (or reports "command not found" = stale host) even if messaging is wedged.
    vscode.commands.registerCommand('cascade.openModels', () => provider?.openModels()),
  )
}

export function deactivate(): Promise<void> | undefined {
  // Tear down MCP subprocesses and run end-of-session memory curation (the dispose path is where
  // durable facts get consolidated — skipping it silently loses them on window close).
  return provider?.dispose()
}
