// templates.ts — project scaffolds (Phase 15). Templates are SERVER assets (not core): a new project is
// created by copying a template's files into the project dir. A template ships an AI_RULES.md the agent
// follows; the server reads it and passes it into the session as generic `extraInstructions` (core stays
// headless — it only sees a string).

import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
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
    // `packs` is EXCLUDED (ADR-066): packs are optional add-ons applied ON DEMAND by applyPack, never
    // copied into a fresh prototype — a new project starts frontend-only.
    filter: (p) => !/[\\/](node_modules|\.git|dist|packs)([\\/]|$)/.test(p),
  })
  // Templates ship `_gitignore` (so it doesn't affect the Cascade repo); restore the dotfile in the project.
  const underscored = join(dest, '_gitignore')
  if (existsSync(underscored)) renameSync(underscored, join(dest, '.gitignore'))
}

// ── Packs (ADR-066): optional capability add-ons a template ships under `packs/<id>/`, applied ON DEMAND
// (by the ApplyPack tool) rather than copied into a fresh prototype. A pack is a normal file tree plus an
// optional `package.pack.json` whose scripts/deps are MERGED into the project's package.json. ──────────

export interface PackInfo {
  id: string
  name: string
  description: string
}

/** Human metadata per pack id (falls back to the id when absent). One place to name/describe packs. */
const PACK_META: Record<string, { name: string; description: string }> = {
  backend: { name: 'Backend', description: 'Express + Prisma + SQLite API; graduates the prototype to a real database without changing the frontend.' },
}

const packsDir = (templateId: string) => join(TEMPLATES_DIR, templateId, 'packs')

/** Packs available for a template (empty if it ships none). */
export function listPacks(templateId: string): PackInfo[] {
  const dir = packsDir(templateId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((id) => statSync(join(dir, id)).isDirectory())
    .map((id) => ({ id, name: PACK_META[id]?.name ?? id, description: PACK_META[id]?.description ?? '' }))
}

/** True once a pack has been applied to a project — detected by a marker path the pack creates. Keeps the
 *  ApplyPack tool from being advertised (or re-run) after graduation. */
export function isPackApplied(projectDir: string, packId: string): boolean {
  // Every pack must create at least one durable directory; `backend` creates `server/`. Marker per pack:
  const marker: Record<string, string> = { backend: 'server' }
  return existsSync(join(projectDir, marker[packId] ?? packId))
}

/** Deep-merge a package.pack.json fragment into the project's package.json. Pack entries WIN on conflict
 *  (the pack's `dev` deliberately replaces the base `dev` to run both processes); everything else is
 *  preserved. Never replaces the whole file (a plain copy would destroy the project's own package.json). */
function mergePackageJson(projectDir: string, fragment: Record<string, unknown>): void {
  const pkgPath = join(projectDir, 'package.json')
  const pkg = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, any>) : {}
  for (const section of ['scripts', 'dependencies', 'devDependencies'] as const) {
    const add = fragment[section] as Record<string, string> | undefined
    if (!add) continue
    pkg[section] = { ...(pkg[section] ?? {}), ...add } // pack values win
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

/** Apply a pack to a project: copy its files in (excluding the package fragment + node_modules), then
 *  merge `package.pack.json` into package.json. Returns a human changelog (files added, deps/scripts
 *  merged) for the tool result. Idempotent-safe: existing files are left as-is by cpSync's overwrite, but
 *  callers gate on isPackApplied so it isn't re-run. Throws on unknown template/pack. */
export function applyPack(projectDir: string, templateId: string, packId: string): string {
  const src = join(packsDir(templateId), packId)
  if (!existsSync(src)) throw new Error(`Unknown pack "${packId}" for template "${templateId}"`)

  const added: string[] = []
  cpSync(src, projectDir, {
    recursive: true,
    filter: (p) => {
      if (/[\\/](node_modules|\.git)([\\/]|$)/.test(p)) return false
      if (p.endsWith('package.pack.json')) return false // merged, not copied
      if (statSync(p).isFile()) added.push(p.slice(src.length + 1).replace(/\\/g, '/'))
      return true
    },
  })

  const fragPath = join(src, 'package.pack.json')
  let scripts: string[] = []
  let deps: string[] = []
  if (existsSync(fragPath)) {
    const frag = JSON.parse(readFileSync(fragPath, 'utf8')) as Record<string, any>
    mergePackageJson(projectDir, frag)
    scripts = Object.keys(frag.scripts ?? {})
    deps = [...Object.keys(frag.dependencies ?? {}), ...Object.keys(frag.devDependencies ?? {})]
  }

  return [
    `Applied the "${PACK_META[packId]?.name ?? packId}" pack.`,
    `Files added: ${added.join(', ')}`,
    scripts.length ? `Scripts: ${scripts.join(', ')}` : '',
    deps.length ? `Dependencies merged: ${deps.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Ensure a project's vite.config carries the M9 visual-edit loc-stamp; if not (older projects predate it),
 *  copy in the current template's config. Safe because every Cascade project uses the same React template. */
export function ensureVisualEditConfig(projectDir: string): void {
  const cfg = join(projectDir, 'vite.config.ts')
  if (!existsSync(cfg)) return
  if (readFileSync(cfg, 'utf8').includes('data-cascade-loc')) return
  const tmpl = join(TEMPLATES_DIR, 'react', 'vite.config.ts')
  if (existsSync(tmpl)) cpSync(tmpl, cfg)
}

/** A project's AI rules (its template's AI_RULES.md), read FRESH so the agent can edit them. '' if none. */
export function readAiRules(projectDir: string): string {
  const path = join(projectDir, AI_RULES_FILE)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}
