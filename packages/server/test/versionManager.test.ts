// The checkpoint/restore safety guard. Measured 2026-07-23: a project whose gitInit failed had no repo of
// its own, so `git add -A` / `reset --hard` walked UP to the enclosing repo — a build checkpoint committed
// the developer's main-repo work-in-progress, and a restore would have hard-reset it. Every op must refuse
// to touch a parent repo.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { VersionManager } from '../src/versionManager'

const git = (dir: string, args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const root = mkdtempSync(join(tmpdir(), 'vm-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let parent: string
let orphan: string // a "project" dir INSIDE the parent repo, with NO repo of its own — the bug's trigger
beforeEach(() => {
  parent = mkdtempSync(join(root, 'parent-'))
  git(parent, ['init', '-q'])
  writeFileSync(join(parent, 'my-work.ts'), 'const important = 1')
  git(parent, ['add', '-A'])
  git(parent, ['commit', '-q', '-m', 'baseline'])
  writeFileSync(join(parent, 'my-work.ts'), 'const important = 2 // UNCOMMITTED edit') // dirty, like real WIP
  orphan = join(parent, 'projects', 'app-x')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'App.tsx'), 'export const App = () => null')
})

describe('VersionManager parent-repo guard', () => {
  const vm = new VersionManager()

  it('checkpoint on a repo-less project does NOT commit the parent — it inits the project instead', () => {
    const parentHeadBefore = git(parent, ['rev-parse', 'HEAD']).trim()

    const committed = vm.checkpoint(orphan, 'build the app')
    expect(committed).toBe(true) // it DID checkpoint…

    // …but in the PROJECT's own new repo, not the parent.
    expect(existsSync(join(orphan, '.git'))).toBe(true)
    expect(git(parent, ['rev-parse', 'HEAD']).trim()).toBe(parentHeadBefore) // parent untouched — the bug is gone
    expect(git(parent, ['status', '--porcelain']).trim()).toContain('my-work.ts') // dev's WIP still uncommitted & safe
  })

  it('restore REFUSES when the dir is not its own repo (never `reset --hard` a parent)', () => {
    const parentHead = git(parent, ['rev-parse', 'HEAD']).trim()
    const bare = join(parent, 'projects', 'no-repo')
    mkdirSync(bare, { recursive: true })

    const ok = vm.restore(bare, parentHead) // an attacker/bug could pass any id
    expect(ok).toBe(false) // refused
    expect(git(parent, ['status', '--porcelain']).trim()).toContain('my-work.ts') // WIP NOT wiped
  })

  it('list returns [] for a repo-less dir (no parent commits masquerading as checkpoints)', () => {
    const bare = join(parent, 'projects', 'no-repo2')
    mkdirSync(bare, { recursive: true })
    expect(vm.list(bare)).toEqual([])
  })

  it('a normal project (its own repo) still checkpoints and lists', () => {
    git(orphan, ['init', '-q']) // this project WAS set up correctly
    expect(vm.checkpoint(orphan, 'first')).toBe(true)
    expect(vm.checkpoint(orphan, 'nothing changed')).toBe(false) // no-op when clean
    writeFileSync(join(orphan, 'App.tsx'), 'export const App = () => <div/>')
    expect(vm.checkpoint(orphan, 'second')).toBe(true)
    const history = vm.list(orphan)
    expect(history.map((v) => v.summary)).toEqual(['second', 'first'])
  })
})
