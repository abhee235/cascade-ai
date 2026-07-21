import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPack, applyTemplate, isPackApplied, listPacks, listTemplates, readAiRules } from '../src/templates'

const tmp = () => mkdtempSync(join(tmpdir(), 'cascade-tpl-'))

describe('templates (Phase 15)', () => {
  it('lists the bundled react template', () => {
    expect(listTemplates().find((t) => t.id === 'react')).toBeTruthy()
  })

  it('applyTemplate copies a runnable scaffold and restores .gitignore from _gitignore', () => {
    const dir = tmp()
    applyTemplate('react', dir)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(true)
    expect(existsSync(join(dir, 'index.html'))).toBe(true)
    expect(existsSync(join(dir, '.gitignore'))).toBe(true) // _gitignore → .gitignore
    expect(existsSync(join(dir, '_gitignore'))).toBe(false)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('vite')
  })

  it('readAiRules returns the template AI rules (fresh from disk)', () => {
    const dir = tmp()
    applyTemplate('react', dir)
    expect(readAiRules(dir)).toContain('Tailwind')
  })

  it('readAiRules is empty for a dir with no rules', () => {
    expect(readAiRules(tmp())).toBe('')
  })

  it('an unknown template throws', () => {
    expect(() => applyTemplate('nope', tmp())).toThrow(/Unknown template/)
  })

  // ── ADR-066: packs (progressive full-stack) ──────────────────────────────────────────────────────
  it('a fresh project does NOT contain the packs directory (packs are on-demand)', () => {
    const dir = tmp()
    applyTemplate('react', dir)
    expect(existsSync(join(dir, 'packs'))).toBe(false)
    expect(existsSync(join(dir, 'src', 'lib', 'storage.ts'))).toBe(true) // the seam DOES ship in the base
  })

  it('lists the backend pack for the react template', () => {
    expect(listPacks('react').find((p) => p.id === 'backend')).toBeTruthy()
  })

  it('applyPack copies the pack files and MERGES package.json without clobbering', () => {
    const dir = tmp()
    applyTemplate('react', dir)
    const before = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(isPackApplied(dir, 'backend')).toBe(false)

    const changelog = applyPack(dir, 'react', 'backend')

    // files landed
    expect(existsSync(join(dir, 'server', 'index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'prisma', 'schema.prisma'))).toBe(true)
    expect(existsSync(join(dir, 'src', 'lib', 'storage.api.ts'))).toBe(true)
    // the package fragment itself is NOT copied (it was merged)
    expect(existsSync(join(dir, 'package.pack.json'))).toBe(false)
    // marker flips
    expect(isPackApplied(dir, 'backend')).toBe(true)

    // package.json: existing entries preserved, pack entries added, pack `dev` wins
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(after.dependencies.react).toBe(before.dependencies.react) // base dep untouched
    expect(after.dependencies.express).toBeTruthy() // pack dep added
    expect(after.devDependencies.prisma).toMatch(/^\^6\./) // Prisma pinned to 6
    expect(after.scripts.dev).toContain('concurrently') // pack dev script wins (runs both)
    expect(after.scripts.build).toBe(before.scripts.build) // base script preserved
    expect(after.scripts['db:migrate']).toBeTruthy()

    expect(changelog).toContain('Backend')
    expect(changelog).toContain('express')
  })

  it('applyPack throws on an unknown pack', () => {
    const dir = tmp()
    applyTemplate('react', dir)
    expect(() => applyPack(dir, 'react', 'nope')).toThrow(/Unknown pack/)
  })

  it('the seam and its API twin are a drop-in swap (same contract methods; typed parity)', () => {
    // Swapping createStore→createApiStore at graduation must not change any view. Guarantees:
    // (1) storage.api's ApiStore EXTENDS Store imported from ./storage — TypeScript enforces full type
    //     parity once both files sit in the project's src/lib (post-graduation).
    // (2) both factories implement every Store contract method (a missing one would break a view).
    const baseSrc = readFileSync('packages/server/templates/react/src/lib/storage.ts', 'utf8')
    const apiSrc = readFileSync('packages/server/templates/react/packs/backend/src/lib/storage.api.ts', 'utf8')
    expect(apiSrc).toMatch(/interface ApiStore<[^>]+> extends Store</) // type parity is compiler-enforced
    expect(apiSrc).toMatch(/from '\.\/storage'/) // via the graduation-relative import
    expect(apiSrc).toMatch(/createApiStore as createStore|createApiStore/) // the swap target exists
    for (const method of ['list', 'get', 'create', 'update', 'remove', 'replaceAll']) {
      expect(baseSrc, `base storage missing ${method}`).toMatch(new RegExp(`\\b${method}\\b`))
      expect(apiSrc, `api storage missing ${method}`).toMatch(new RegExp(`\\b${method}\\b`))
    }
  })
})
