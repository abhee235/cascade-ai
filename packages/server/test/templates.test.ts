import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTemplate, listTemplates, readAiRules } from '../src/templates'

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
})
