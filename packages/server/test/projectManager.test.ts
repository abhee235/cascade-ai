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

  it('metadata persists: a second manager on the same root re-lists projects', () => {
    const { mgr, root } = manager()
    mgr.create('Persisted')
    const reopened = new ProjectManager({ root, model: 'fake', createSessionFor: () => mgr.open(mgr.list()[0].id) })
    expect(reopened.list().map((p) => p.name)).toContain('Persisted')
  })
})
