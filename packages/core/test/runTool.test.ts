import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTool } from '../src/tools/runTool'

const ctx = (cwd: string) => ({ cwd, abortSignal: new AbortController().signal })

describe('executeTool pipeline', () => {
  it('unknown tool → isError result (not a throw)', async () => {
    const r: any = await executeTool({ id: '1', name: 'Nope', input: {} }, ctx(process.cwd()))
    expect(r.type).toBe('tool_result')
    expect(r.isError).toBe(true)
    expect(r.content).toContain('No such tool')
  })

  it('invalid input → isError with a validation message (self-correction)', async () => {
    const r: any = await executeTool({ id: '1', name: 'Read', input: {} }, ctx(process.cwd())) // missing file_path
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Invalid input/i)
  })

  it('valid Read → returns the file contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-'))
    try {
      await writeFile(join(dir, 'hi.txt'), 'hello world')
      const r: any = await executeTool({ id: '1', name: 'Read', input: { file_path: 'hi.txt' } }, ctx(dir))
      expect(r.isError).toBeFalsy()
      expect(r.content).toBe('hello world')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
