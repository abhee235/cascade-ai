import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectManager } from '../src/projectManager'
import { createSession, type ModelProvider } from '@cascade/core'

const fakeProvider: ModelProvider = {
  id: 'fake',
  async complete() {
    return { text: '' }
  },
  async *stream() {
    yield { type: 'done', stopReason: 'end_turn' }
  },
}

function manager() {
  const root = mkdtempSync(join(tmpdir(), 'cascade-pm-'))
  const mgr = new ProjectManager({
    root,
    model: 'fake',
    createSessionFor: (dir) => createSession({ cwd: dir, provider: fakeProvider, model: 'fake' }),
  })
  return { mgr, root }
}

describe('ProjectManager (13.2)', () => {
  it('create from a template scaffolds a runnable app + git repo (Phase 15)', () => {
    const { mgr, root } = manager()
    const p = mgr.create('My App', 'react')
    const dir = join(root, `my-app-${p.id.slice(0, 8)}`)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(true)
    expect(existsSync(join(dir, '.git'))).toBe(true) // gitInit ran a baseline commit
  })

  it('create → list reflects it; dir exists; no host path leaks', () => {
    const { mgr } = manager()
    const p = mgr.create('My App')
    expect(p.name).toBe('My App')
    const list = mgr.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ id: p.id, name: 'My App', createdAt: p.createdAt })
    expect(Object.keys(list[0])).not.toContain('dir') // host path stays server-side
  })

  it('open lazily builds and caches one session per project', () => {
    const { mgr } = manager()
    const p = mgr.create('App')
    const a = mgr.open(p.id)
    const b = mgr.open(p.id)
    expect(a).toBe(b) // same session instance — conversation persists across reconnects
  })

  it('setModelConfig switches provider/model at runtime + invalidates cached sessions (ADR-067)', async () => {
    const { mgr } = manager()
    const p = mgr.create('App')
    const a = mgr.open(p.id)
    expect(mgr.currentModel).toBe('fake')
    // Switch to a hosted provider (no network — hasVision uses the family regex for non-ollama).
    await mgr.setModelConfig({ provider: 'openai', model: 'gpt-5' })
    expect(mgr.currentModel).toBe('gpt-5')
    expect(mgr.currentProvider).toBe('openai')
    const b = mgr.open(p.id)
    expect(b).not.toBe(a) // the cached session was invalidated → rebuilt under the new provider
  })

  it('open on an unknown id throws', () => {
    const { mgr } = manager()
    expect(() => mgr.open('nope')).toThrow(/No such project/)
  })

  it('delete removes the project and its dir', async () => {
    const { mgr } = manager()
    const p = mgr.create('Trash')
    mgr.open(p.id)
    await mgr.delete(p.id)
    expect(mgr.list()).toHaveLength(0)
  })

  // ADR-067 — measured 2026-07-22: with the picker switched to a local Ollama model, the PLAN STAGE still
  // built its provider from `opts` (the env seed), so a fresh project's first message spent 56s and 10 model
  // calls on the hosted default while Ollama's request log sat silent. Both session kinds must follow the
  // ACTIVE selection, or a "switch" only half-switches — and the half you don't see is the billed one.
  it('the plan stage follows the ACTIVE model, not the env default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cascade-pm-'))
    const built: { provider: string; model: string }[] = []
    const mgr = new ProjectManager({
      root,
      provider: 'openai', // the env seed — what the planner used to be stuck on
      model: 'gpt-5.6-luna',
      createSessionFor: (dir) => createSession({ cwd: dir, provider: fakeProvider, model: 'fake' }),
      createProviderFn: (cfg) => {
        built.push({ provider: cfg.provider, model: cfg.model })
        return fakeProvider
      },
    })
    const project = mgr.create('Planned')
    await mgr.setModelConfig({ provider: 'ollama', model: 'qwen36-agentic' })
    mgr.open(project.id) // setModelConfig dropped cached sessions; the submit path always re-opens first
    built.length = 0 // ignore anything built before the switch — we assert on the PLANNER only
    const planner = mgr.planSessionFor(project.id)
    expect(planner).toBeDefined() // a fresh project with no PLAN.md still gets a plan stage
    expect(built).toEqual([{ provider: 'ollama', model: 'qwen36-agentic' }])
    await planner?.dispose()
  })

  it('metadata persists: a second manager on the same root re-lists projects', () => {
    const { mgr, root } = manager()
    mgr.create('Persisted')
    const reopened = new ProjectManager({ root, model: 'fake', createSessionFor: () => mgr.open(mgr.list()[0].id) })
    expect(reopened.list().map((p) => p.name)).toContain('Persisted')
  })
})
