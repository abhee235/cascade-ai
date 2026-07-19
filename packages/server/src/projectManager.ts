// projectManager.ts — the server's stateful core (Phase 13.2).
//
// A *project* is a workspace dir on the host plus its own long-lived CascadeSession. The manager OWNS
// these sessions, keyed by project id — they outlive any single WebSocket connection, so a project's
// conversation survives you closing the browser tab and coming back. A connection merely *attaches* to a
// project (see wsServer.ts). It is a server-side session registry: sessions are decoupled from the
// client transport.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProvider, createSession, type AgentDef, type CascadeSession, type Sandbox } from '@cascade/core'
import type { ProjectInfo } from '@cascade/app-protocol'
import { applyTemplate, readAiRules } from './templates.js'
import { createPlannerSession, needsPlanStage } from './planStage.js'

/** Initialize a git repo in `dir` with one commit — the baseline for checkpoints (Phase 18). Best-effort. */
function gitInit(dir: string): void {
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Cascade', '-c', 'user.email=cascade@local', 'commit', '-q', '-m', 'Initial commit from template'], { cwd: dir, stdio: 'ignore' })
  } catch {
    /* git missing or nothing to commit — don't fail project creation */
  }
}

/** Internal record: the public ProjectInfo + the host dir + the lazily-created session & sandbox. */
type Project = ProjectInfo & { dir: string; session?: CascadeSession; sandbox?: Sandbox }

export interface ProjectManagerOptions {
  /** Host dir under which each project gets its own subdir. */
  root: string
  model: string
  baseUrl?: string
  /** Build a per-project execution sandbox (13.3). The default wiring passes a DockerSandbox when Docker is
   *  available; tests pass none (host exec). The manager owns the sandbox lifecycle (disposed with the project). */
  sandboxFor?: (dir: string) => Sandbox | undefined
  /** How to build a project's session. Injected so tests can pass a FakeProvider. Default: an Ollama-backed
   *  session rooted at the project dir, with the project's sandbox (if any) + AI rules injected. */
  createSessionFor?: (dir: string, sandbox?: Sandbox, extraInstructions?: string) => CascadeSession
  /** How to build a plan-stage session (ADR-056 rung 3). Injected for tests; default: planStage.ts. */
  createPlanSessionFor?: (dir: string, def: AgentDef, sandbox?: Sandbox) => CascadeSession
}

/** Builder behavior injected ahead of every project's AI rules (as generic `extraInstructions`). The core
 *  base prompt is concise-chat-tuned, which makes the model explore then stop; the builder needs the opposite:
 *  keep using tools until the whole app is actually built. Kept here (server/wrapper), not in headless core.
 *  Exported so the Tier-3 builder bench runs sessions IDENTICAL to the product's (forensic fidelity). */
export const BUILDER_BEHAVIOR = [
  'You are an autonomous app builder operating in a sandboxed project. Your job is to BUILD, not to chat.',
  'When asked to build or change the app:',
  '- Complete the ENTIRE request in this turn. Create or edit every file needed, one tool call at a time, until it is fully done.',
  '- Do not stop after exploring or after writing a plan. A plan or explanation is NOT a deliverable — the working files are.',
  '- Keep going tool-by-tool (write a file, then the next…). Do not ask for confirmation; you are sandboxed and pre-authorized.',
  '- Only end your turn when the feature is fully implemented and the app still runs (`npm run dev` must work).',
  '- Be thorough over brief: prefer many correct file edits over a short summary. Ignore any instinct to keep the response short.',
  // Measured (shop-iterate-1): one ever-growing App.tsx crossed the read cap by round 2 — every later edit
  // fought windowed reads and stale views. Many small files keep every read/edit cheap and precise.
  '- ARCHITECTURE: split the app into small components (src/components/*.tsx, one per concern) and keep every file under ~150 lines. Never let one file grow without bound — extract components as you go.',
  // ADR-056 rung 3+5: fresh-project planning is ORCHESTRATED (the server runs the planner before the first
  // build message — planner-1 measured that the model overrules polite requests), and the resulting PLAN.md
  // is PINNED into this prompt under "Pinned context" (rung 5 — always present, no need to Read it).
  '- PLAN: your PLAN.md appears under "Pinned context" below — it is the contract for this app. Build EXACTLY the views, components, and data model it specifies; do not invent structure that contradicts it. For a MAJOR new feature that changes the plan, update it first: Subagent {agent: "planner", prompt: <the feature request>} (the pinned copy refreshes automatically).',
  // Weak models route poorly on categories — the two ALWAYS-needed skills are mandated, not routed
  // (the situational ones — data/forms/auth/dashboard/landing — carry literal trigger words instead).
  '- MANDATORY SKILLS: before your FIRST Write or Edit in a session, call Skill {name: "architecture"} and Skill {name: "design"}. This is not optional. Load the other skills when their trigger words match the task.',
  // Design-system v2: the aesthetic bar, one line (the mechanics live in the design skill
  // + the blocks; this makes "looks designed" part of the definition of done).
  '- QUALITY BAR: the app must look DESIGNED, not scaffolded — assemble pages from src/components/blocks (NavBar/Hero/Section/MediaCard…), token colors only (never bg-white/bg-blue-600/hex), real imagery via photoFor()/ArtImage (NEVER an emoji as an image). First impression is part of "done".',
].join('\n')

/** name → a filesystem-safe slug (so dirs are readable); id keeps them unique. */
const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project'

/** The capability dirs every builder-facing session shares: server-owned base first (immutable), then the
 *  project's own `.cascade/` (user-owned; shadows base by name). One definition — builder, plan stage,
 *  and the eval bench must all see the SAME capabilities. */
export const skillDirsFor = (dir: string) => [join(import.meta.dirname, '..', 'skills', 'builder'), join(dir, '.cascade', 'skills')]
export const agentDirsFor = (dir: string) => [join(import.meta.dirname, '..', 'agents', 'builder'), join(dir, '.cascade', 'agents')]

export class ProjectManager {
  private readonly projects = new Map<string, Project>()
  private readonly createSessionFor: (dir: string, sandbox?: Sandbox, extraInstructions?: string) => CascadeSession
  private readonly metaFile: string

  constructor(private readonly opts: ProjectManagerOptions) {
    mkdirSync(opts.root, { recursive: true })
    this.metaFile = join(opts.root, 'projects.json')
    this.createSessionFor =
      opts.createSessionFor ??
      ((dir, sandbox, extraInstructions) =>
        createSession({
          cwd: dir,
          provider: createProvider({ provider: 'ollama', model: opts.model, baseUrl: opts.baseUrl }),
          model: opts.model,
          sandbox, // 13.3: command tools run in the project's sandbox when present
          // Sandboxed ⇒ auto-allow (the builder is contained; it shouldn't prompt for every command/edit).
          // Without a sandbox we keep the default gate (the host is not isolated).
          mode: sandbox ? 'bypass' : 'default',
          // Prepend builder behavior to the template's AI rules. The core base prompt is tuned for concise
          // chat ("short, direct responses"), which makes the model stop after exploring; the builder must
          // instead keep using tools until the whole app is built. This OVERRIDES the concise default.
          extraInstructions: [BUILDER_BEHAVIOR, extraInstructions].filter(Boolean).join('\n\n'),
          // A full build is many model round-trips (one per file batch); the chat default of 10 is far too low.
          maxTurns: 80,
          // ADR-036 SAFETY: the project dir is MODEL-WRITABLE, but hook commands spawn on the HOST — never
          // load a hooks.json the builder itself could have written (sandbox escape at the next open()).
          loadProjectHooks: false,
          // ADR-051: a builder project is "done" when it compiles — declare it, so the verify gate holds the
          // model to `npm run build` by name instead of accepting "I created all the files" on faith.
          checkCommand: 'npm run build',
          // ADR-055: base skills are SERVER-owned (immutable — outside the project and the Read jail);
          // user skills in the project shadow base by name and are theirs to edit.
          skillDirs: skillDirsFor(dir),
          // ADR-056: named agents — base personas server-owned; user personas in the project shadow by name.
          // ADR-056 rung 2 activation is NOT wired here: the base planner.md declares `proactive: true`
          // in its own frontmatter (the idiom: policy travels with the capability, never a session flag).
          agentDirs: agentDirsFor(dir),
          // ADR-056 rung 5: PLAN.md is pinned into the builder's system prompt, re-read each turn — the
          // contract is ALWAYS in context (measured: the builder read it 0 times when only on disk), and
          // survives compaction across iterate rounds (the whole reason a durable plan exists).
          contextFiles: [join(dir, 'PLAN.md')],
        }))
    this.load()
  }

  /** ADR-056 rung 3: the plan stage. If this project's NEXT submit is the first message of a fresh,
   *  unplanned project (and a proactive planner is mounted), build the planner's one-shot TOP-LEVEL
   *  session. The caller runs it to completion (PLAN.md lands on disk), disposes it, then submits the
   *  user's message to the builder as usual. Undefined ⇒ no stage. */
  planSessionFor(id: string): CascadeSession | undefined {
    const project = this.projects.get(id)
    if (!project?.session) return undefined // not open()ed — the submit path always opens first
    const def = needsPlanStage(project.dir, project.session.getHistory().length, agentDirsFor(project.dir))
    if (!def) return undefined
    const build =
      this.opts.createPlanSessionFor ??
      ((dir: string, d: AgentDef, sandbox?: Sandbox) =>
        createPlannerSession(d, {
          dir,
          provider: createProvider({ provider: 'ollama', model: this.opts.model, baseUrl: this.opts.baseUrl }),
          model: this.opts.model,
          skillDirs: skillDirsFor(dir),
          sandbox,
        }))
    return build(project.dir, def, project.sandbox)
  }

  /** The host dir of a project — SERVER-INTERNAL only (never crosses the wire). For the file service. */
  dirOf(id: string): string | undefined {
    return this.projects.get(id)?.dir
  }

  /** The project's sandbox (created on open) — SERVER-INTERNAL. For live preview (the dev server runs in it). */
  sandboxOf(id: string): Sandbox | undefined {
    return this.projects.get(id)?.sandbox
  }

  /** Public, host-path-free snapshot for the sidebar. */
  list(): ProjectInfo[] {
    return [...this.projects.values()]
      .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Create a new project: a dir on disk (optionally scaffolded from a template + git-init'd) + a metadata
   *  record. The session is NOT built until open(). */
  create(name: string, templateId?: string): ProjectInfo {
    const id = randomUUID()
    const dir = join(this.opts.root, `${slug(name)}-${id.slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    if (templateId) {
      applyTemplate(templateId, dir) // copy the scaffold (Vite+React+TS+Tailwind, etc.)
      gitInit(dir) // baseline commit for future checkpoints (Phase 18)
    }
    const project: Project = { id, name: name.trim() || 'Untitled', createdAt: new Date().toISOString(), dir }
    this.projects.set(id, project)
    this.save()
    return { id: project.id, name: project.name, createdAt: project.createdAt }
  }

  /** Attach to a project: lazily build (and cache) its sandbox + session on first open. Throws if unknown. */
  open(id: string): CascadeSession {
    const project = this.projects.get(id)
    if (!project) throw new Error(`No such project: ${id}`)
    if (!project.session) {
      project.sandbox = this.opts.sandboxFor?.(project.dir)
      // Read the template's AI rules FRESH (the agent may edit them) and inject as system-prompt context.
      project.session = this.createSessionFor(project.dir, project.sandbox, readAiRules(project.dir))
    }
    return project.session
  }

  /** Delete a project: tear down its session + sandbox and remove its dir. */
  async delete(id: string): Promise<void> {
    const project = this.projects.get(id)
    if (!project) return
    await project.session?.dispose()
    await project.sandbox?.dispose()
    this.projects.delete(id)
    rmSync(project.dir, { recursive: true, force: true })
    this.save()
  }

  /** Dispose every live session + sandbox (server shutdown). Dirs stay on disk. */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.projects.values()].flatMap((p) => [p.session?.dispose(), p.sandbox?.dispose()]),
    )
  }

  // ── persistence: only metadata, never sessions ──────────────────────────────────────────
  private load(): void {
    if (!existsSync(this.metaFile)) return
    try {
      const rows = JSON.parse(readFileSync(this.metaFile, 'utf8')) as Project[]
      for (const r of rows) if (existsSync(r.dir)) this.projects.set(r.id, { ...r, session: undefined })
    } catch {
      /* corrupt metadata → start empty rather than crash */
    }
  }

  private save(): void {
    const rows = [...this.projects.values()].map(({ id, name, createdAt, dir }) => ({ id, name, createdAt, dir }))
    writeFileSync(this.metaFile, JSON.stringify(rows, null, 2))
  }
}
