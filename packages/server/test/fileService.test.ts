import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, readTree } from '../src/fileService'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cascade-fs-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
  writeFileSync(join(dir, 'src', 'App.tsx'), 'export default () => null')
  writeFileSync(join(dir, 'node_modules', 'junk.js'), 'junk')
  return dir
}

describe('fileService (M4)', () => {
  it('readTree: dirs first, recurses, skips node_modules; paths are relative', () => {
    const tree = readTree(fixture())
    const names = tree.map((n) => n.name)
    expect(names).toContain('src')
    expect(names).toContain('package.json')
    expect(names).not.toContain('node_modules') // skipped
    expect(names.indexOf('src')).toBeLessThan(names.indexOf('package.json')) // dirs first
    const src = tree.find((n) => n.name === 'src')
    expect(src?.type).toBe('dir')
    expect(src?.children?.map((c) => c.name)).toContain('App.tsx')
    expect(src?.children?.[0].path).toBe('src/App.tsx') // forward-slash relative path
  })

  it('readFile returns content', () => {
    expect(readFile(fixture(), 'src/App.tsx').content).toContain('export default')
  })

  it('readFile blocks path traversal', () => {
    expect(() => readFile(fixture(), '../../etc/passwd')).toThrow(/outside/)
  })
})
