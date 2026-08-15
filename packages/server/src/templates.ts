// templates.ts — project scaffolds (Phase 15). Templates are SERVER assets (not core): a new project is
// created by copying a template's files into the project dir. A template ships an AI_RULES.md the agent
// follows; the server reads it and passes it into the session as generic `extraInstructions` (core stays
// headless — it only sees a string).

import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resourceDir } from './resources.js'

const TEMPLATES_DIR = resourceDir('templates')
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

// ── Residue contract (design-overhaul P1): what must be GONE before a generated app is "done" ─────────────
// The contract lives in the template dir (data beside the data it describes, like package.pack.json) and is
// read from TEMPLATES_DIR — outside the project and outside the model's Read jail, so the builder can never
// edit the contract to pass its own audit. The TemplateAudit tool (auditTool.ts) is its only consumer.

export interface ResidueFinding {
  kind: 'path' | 'string' | 'file'
  /** kind 'path'/'file': project-relative path. */
  path?: string
  /** kind 'string': the literal needle that must not appear. */
  needle?: string
  /** kind 'string': project-relative directory to scan (default 'src'). */
  scope?: string
  /** kind 'file': the literal content that must not appear in `path`. */
  mustNotContain?: string
  why: string
  fix: string
}

export interface ResidueContract {
  hard: ResidueFinding[]
  soft: ResidueFinding[]
}

/** The template's residue contract, or undefined when the template ships none (audit self-disables). */
export function readResidueContract(templateId: string): ResidueContract | undefined {
  try {
    const raw = readFileSync(join(TEMPLATES_DIR, templateId, 'residue.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ResidueContract>
    if (!Array.isArray(parsed.hard) && !Array.isArray(parsed.soft)) return undefined
    return { hard: parsed.hard ?? [], soft: parsed.soft ?? [] }
  } catch {
    return undefined // no contract, unreadable, malformed — the audit simply doesn't exist for this template
  }
}

/**
 * What NEVER reaches a generated project:
 * - `packs` (ADR-066): optional add-ons applied ON DEMAND by applyPack — a new project starts frontend-only.
 * - `demo` (design-overhaul P1): the gallery lives at the template ROOT and never ships, so demo residue
 *   in generated apps (the measured Meridian class) is structurally impossible.
 * - `residue.json`: the audit contract, read server-side from TEMPLATES_DIR — never copied, so the builder
 *   can't edit the contract to pass its own audit.
 * - `node_modules`/`.git`/`dist`/`*.tsbuildinfo`: build machinery, never source. (A tsbuildinfo left by a
 *   local `npm run build` in the template would seed a fresh project with another tree's incremental state.)
 *
 * EXPORTED so the eval bench scaffolds byte-identically (scripts/eval/builder.mts). It previously copied
 * the template raw, which handed every run a `demo/` containing complete reference implementations — an
 * answer key for the very scenarios being measured — and a stray `node_modules` (from a plain `npm install`
 * in the template dir, which is a reasonable thing to do) crashed the shared-deps junction outright. One
 * filter, one scaffold: the bench cannot drift from what users actually get.
 */
/** Absolute path to a file inside a template's pristine source — the ground truth a generated project's
 *  copy is compared against (see the audit's frozen-layer check). Read from TEMPLATES_DIR, which is
 *  outside the model's Read jail, so a project can never doctor its own reference copy. */
export function templateFilePath(templateId: string, relPath: string): string {
  return join(TEMPLATES_DIR, templateId, relPath)
}

export function templateCopyFilter(p: string): boolean {
  return !/[\\/](node_modules|\.git|dist|packs|demo|residue\.json|[^\\/]+\.tsbuildinfo)([\\/]|$)/.test(p)
}

/** Copy a template's files into `dest` (see templateCopyFilter; `_gitignore` → `.gitignore`). */
export function applyTemplate(templateId: string, dest: string): void {
  const src = join(TEMPLATES_DIR, templateId)
  if (!existsSync(src)) throw new Error(`Unknown template: ${templateId}`)
  cpSync(src, dest, { recursive: true, filter: templateCopyFilter })
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
