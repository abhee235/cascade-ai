// agent/systemPrompt.ts — builds the system prompt: identity + environment grounding.
//
// The system prompt is prepended to EVERY request (Phase 3). It sets who the agent is and gives it
// the facts it can't otherwise know — the working directory, OS, and date. Without it the model can't
// answer "what directory are you in?". Kept pure + headless (node:os only, no vscode).
//

import { platform } from 'node:os'
import { loadMemory } from '../memory/memoryStore'

export interface SystemPromptInput {
  cwd: string
  /** When the session runs in a sandbox, the path the project is mounted at inside it (e.g. '/workspace').
   *  Shown to the model as the working directory so its view matches where Bash actually runs; the file tools
   *  reconcile it back to the host project dir (ADR-033). Absent ⇒ host mode, the real cwd is shown. */
  sandboxRoot?: string
  /** Archival memories auto-retrieved for THIS user message (proactive retrieval, ADR-015) — injected so
   *  the model sees relevant past facts without having to call MemorySearch. */
  recalled?: string
  /** Generic extra system-prompt context the FRONTEND supplies (Phase 15). Headless: just a string. The
   *  builder uses it to inject a project template's AI rules ("this is a Vite+React+TS app; edit src/…"). */
  extraInstructions?: string
}

export function buildSystemPrompt({ cwd, sandboxRoot, recalled, extraInstructions }: SystemPromptInput): string {
  const today = new Date().toISOString().slice(0, 10)
  // Show ONE coherent root: the in-sandbox mount when sandboxed (so Bash + the model + file tools all agree),
  // otherwise the host cwd. Either way, instruct relative paths — they always land in the project (ADR-033).
  const workdir = sandboxRoot ?? cwd
  const base = [
    'You are Cascade, a concise, helpful coding assistant running inside VS Code.',
    'Answer clearly and use Markdown. Prefer short, direct responses; show code in fenced blocks.',
    '',
    'Environment:',
    `- Working directory: ${workdir}`,
    `- OS: ${platform()}`,
    `- Date: ${today}`,
    `- Address files by paths relative to the working directory (e.g. "src/App.tsx"). Paths outside the project are rejected.`,
  ].join('\n')
  // Durable memory is read FRESH each call (cheap, local files), so Memory-tool writes show up immediately.
  // It's appended to the system prompt — outside the conversation history, so compaction never drops it.
  const memory = loadMemory(cwd)
  let prompt = memory ? `${base}\n\n${memory}` : base
  // Frontend-supplied context (e.g. a project template's AI rules). Outside the conversation history, so
  // compaction never drops it.
  if (extraInstructions) prompt += `\n\n${extraInstructions}`
  // Proactive retrieval: relevant archival memories for this turn, surfaced automatically (lower trust than
  // core — the model should verify, since they're retrieved by similarity).
  if (recalled) {
    prompt += `\n\nPossibly relevant memories from past sessions (retrieved by similarity — verify before relying):\n${recalled}`
  }
  return prompt
}
