// agent/systemPrompt.ts — builds the system prompt: identity + environment grounding.
//
// The system prompt is prepended to EVERY request (Phase 3). It sets who the agent is and gives it
// the facts it can't otherwise know — the working directory, OS, and date. Without it the model can't
// answer "what directory are you in?". Kept pure + headless (node:os only, no vscode).
//

import { platform } from 'node:os'

export interface SystemPromptInput {
  cwd: string
}

export function buildSystemPrompt({ cwd }: SystemPromptInput): string {
  const today = new Date().toISOString().slice(0, 10)
  return [
    'You are Cascade, a concise, helpful coding assistant running inside VS Code.',
    'Answer clearly and use Markdown. Prefer short, direct responses; show code in fenced blocks.',
    '',
    'Environment:',
    `- Working directory: ${cwd}`,
    `- OS: ${platform()}`,
    `- Date: ${today}`,
  ].join('\n')
}
