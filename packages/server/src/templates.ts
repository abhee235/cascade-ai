// templates.ts — project scaffolds (Phase 15). Templates are SERVER assets (not core): a new project is
// created by copying a template's files into the project dir. A template ships an AI_RULES.md the agent
// follows; the server reads it and passes it into the session as generic `extraInstructions` (core stays
// headless — it only sees a string).

import { cpSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates')
const AI_RULES_FILE = 'AI_RULES.md'

export interface TemplateInfo {
  id: string
  name: string
  description: string
}

const REGISTRY: TemplateInfo[] = [
  { id: 'react', name: 'React', description: 'Vite + React + TypeScript + Tailwind CSS' },
]

/** Available templates whose files actually exist on disk. */
export function listTemplates(): TemplateInfo[] {
  return REGISTRY.filter((t) => existsSync(join(TEMPLATES_DIR, t.id)))
}

/** Copy a template's files into `dest` (skipping node_modules/.git/dist; `_gitignore` → `.gitignore`). */
export function applyTemplate(templateId: string, dest: string): void {
  const src = join(TEMPLATES_DIR, templateId)
  if (!existsSync(src)) throw new Error(`Unknown template: ${templateId}`)
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|\.git|dist)([\\/]|$)/.test(p),
  })
  // Templates ship `_gitignore` (so it doesn't affect the Cascade repo); restore the dotfile in the project.
  const underscored = join(dest, '_gitignore')
  if (existsSync(underscored)) renameSync(underscored, join(dest, '.gitignore'))
}

/** A project's AI rules (its template's AI_RULES.md), read FRESH so the agent can edit them. '' if none. */
export function readAiRules(projectDir: string): string {
  const path = join(projectDir, AI_RULES_FILE)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}
