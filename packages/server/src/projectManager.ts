// projectManager.ts — the server's stateful core (Phase 13.2).
//
// A *project* is a workspace dir on the host plus its own long-lived CascadeSession. The manager OWNS
// these sessions, keyed by project id — they outlive any single WebSocket connection, so a project's
// conversation survives you closing the browser tab and coming back. A connection merely *attaches* to a
// project (see wsServer.ts). It is a server-side session registry: sessions are decoupled from the
// client transport.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProvider, createSession, type CascadeSession, type Sandbox } from '@cascade/core'
import type { ProjectInfo } from '@cascade/app-protocol'

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
   *  session rooted at the project dir, with the project's sandbox (if any) injected. */
  createSessionFor?: (dir: string, sandbox?: Sandbox) => CascadeSession
}

/** name → a filesystem-safe slug (so dirs are readable); id keeps them unique. */
const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project'

export class ProjectManager {
  private readonly projects = new Map<string, Project>()
  private readonly createSessionFor: (dir: string, sandbox?: Sandbox) => CascadeSession
  private readonly metaFile: string

  constructor(private readonly opts: ProjectManagerOptions) {
    mkdirSync(opts.root, { recursive: true })
    this.metaFile = join(opts.root, 'projects.json')
    this.createSessionFor =
      opts.createSessionFor ??
      ((dir, sandbox) =>
        createSession({
          cwd: dir,
          provider: createProvider({ provider: 'ollama', model: opts.model, baseUrl: opts.baseUrl }),
          model: opts.model,
          sandbox, // 13.3: command tools run in the project's sandbox when present
        }))
    this.load()
  }

  /** Public, host-path-free snapshot for the sidebar. */
  list(): ProjectInfo[] {
    return [...this.projects.values()]
      .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Create a new project: a dir on disk + a metadata record. The session is NOT built until open(). */
  create(name: string): ProjectInfo {
    const id = randomUUID()
    const dir = join(this.opts.root, `${slug(name)}-${id.slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
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
      project.session = this.createSessionFor(project.dir, project.sandbox)
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
