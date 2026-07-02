import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MultiEditTool } from '../src/tools/builtins/MultiEdit'
import { FileStateCache } from '../src/tools/fileState'

function project(initial: string): { dir: string; file: string; read: string } {
  const dir = mkdtempSync(join(tmpdir(), 'multiedit-'))
  const file = join(dir, 'f.txt')
  writeFileSync(file, initial)
  return { dir, file, read: readFileSync(file, 'utf8') }
}
// ctx without a freshness cache → the read-before-edit guard is a no-op (apply-logic tests).
const ctx = (dir: string): any => ({ cwd: dir, abortSignal: new AbortController().signal, depth: 0 })

describe('MultiEdit — atomic sequential edits (ADR-042)', () => {
  it('applies edits IN ORDER, each to the result of the previous', async () => {
    const { dir, file } = project('a b c')
    const r = await MultiEditTool.call({ file_path: 'f.txt', edits: [{ old_string: 'a', new_string: 'X' }, { old_string: 'b', new_string: 'Y' }] }, ctx(dir))
    expect(r.isError).toBeFalsy()
    expect(readFileSync(file, 'utf8')).toBe('X Y c')
    rmSync(dir, { recursive: true, force: true })
  })

  it('is ATOMIC: a later failing edit leaves the file completely untouched', async () => {
    const { dir, file } = project('a b c')
    const r = await MultiEditTool.call({ file_path: 'f.txt', edits: [{ old_string: 'a', new_string: 'X' }, { old_string: 'zzz', new_string: 'Y' }] }, ctx(dir))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/edit #2/)
    expect(readFileSync(file, 'utf8')).toBe('a b c') // NOT "X b c" — nothing written
    rmSync(dir, { recursive: true, force: true })
  })

  it('collision guard: an old_string that matches an earlier new_string is rejected', async () => {
    const { dir } = project('foo here')
    const r = await MultiEditTool.call({ file_path: 'f.txt', edits: [{ old_string: 'foo', new_string: 'foobar' }, { old_string: 'foobar', new_string: 'baz' }] }, ctx(dir))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/edit #2/)
    expect(r.content).toMatch(/substring/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('non-unique old_string without replace_all → error naming the count', async () => {
    const { dir } = project('x x x')
    const r = await MultiEditTool.call({ file_path: 'f.txt', edits: [{ old_string: 'x', new_string: 'Y' }] }, ctx(dir))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/appears 3×/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('replace_all renames every occurrence', async () => {
    const { dir, file } = project('count = count + count')
    const r = await MultiEditTool.call({ file_path: 'f.txt', edits: [{ old_string: 'count', new_string: 'n', replace_all: true }] }, ctx(dir))
    expect(r.isError).toBeFalsy()
    expect(readFileSync(file, 'utf8')).toBe('n = n + n')
    rmSync(dir, { recursive: true, force: true })
  })

  it('$-sequences in new_string are inserted LITERALLY (not $1/$& expansion)', async () => {
    const { dir, file } = project('const price = 0')
    const r = await MultiEditTool.call({ file_path: 'f.txt', edits: [{ old_string: '0', new_string: '$0.99 $& $1' }] }, ctx(dir))
    expect(r.isError).toBeFalsy()
    expect(readFileSync(file, 'utf8')).toBe('const price = $0.99 $& $1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('read-before-edit freshness is enforced (shared with Edit, ADR-032)', async () => {
    const { dir } = project('a b')
    const withCache: any = { cwd: dir, abortSignal: new AbortController().signal, depth: 0, readFileState: new FileStateCache() }
    const r = await MultiEditTool.call({ file_path: 'f.txt', edits: [{ old_string: 'a', new_string: 'X' }] }, withCache)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/has not been read yet/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('path outside the project is rejected (ADR-033)', async () => {
    const { dir } = project('a')
    const r = await MultiEditTool.call({ file_path: '../escape.txt', edits: [{ old_string: 'a', new_string: 'X' }] }, ctx(dir))
    expect(r.isError).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
