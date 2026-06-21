// VS Code extension entry (the frontend host wiring).
import * as vscode from 'vscode'
import { CascadeViewProvider } from './CascadeViewProvider'

export function activate(context: vscode.ExtensionContext) {
  const provider = new CascadeViewProvider(context)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CascadeViewProvider.viewId, provider),
  )
}

export function deactivate() {
  /* nothing to clean up yet */
}
