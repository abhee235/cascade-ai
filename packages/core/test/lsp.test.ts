import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LspTool } from '../src/tools/builtins/Lsp'
import { clearLspCache } from '../src/lsp/tsService'

let root: string
const ctx = (): any => ({ cwd: root, abortSignal: new AbortController().signal, depth: 0 }) // no sandbox → LanguageService

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lsp-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' } }))
  writeFileSync(join(root, 'src/util.ts'), 'export function greet(name: string): string {\n  return "hi " + name\n}\n')
  // line 2 has a type error (string assigned to number); `greet` is used 3× + defined once.
  writeFileSync(join(root, 'src/app.ts'), "import { greet } from './util'\nconst x: number = greet('a')\ngreet('b')\n")
})
afterAll(() => {
  clearLspCache()
  rmSync(root, { recursive: true, force: true })
})

// ADR-075: the Lsp tool is NAVIGATION-ONLY. Diagnostics are no longer a pull op here — type errors are pushed
// after each edit by postEditCheck (a weak model won't pull them, and a pull check that disagrees with the push
// is pure thrash). So these tests cover definition/references/hover only.
describe('Lsp tool — real TS semantics via the in-process LanguageService (ADR-041)', () => {
  it('definition: jumps ACROSS files to the real declaration', async () => {
    const r = await LspTool.call({ op: 'definition', file: 'src/app.ts', line: 3, column: 1 }, ctx())
    expect(r.content).toMatch(/util\.ts:1:/)
  })
  it('references: finds every use (the safe-rename win Grep cannot do reliably)', async () => {
    const r = await LspTool.call({ op: 'references', file: 'src/app.ts', line: 3, column: 1 }, ctx())
    expect((r.content.match(/\.ts:\d+:\d+/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
  it('hover: shows the type signature', async () => {
    const r = await LspTool.call({ op: 'hover', file: 'src/app.ts', line: 3, column: 1 }, ctx())
    expect(r.content).toMatch(/greet\(name: string\): string/)
  })
  it('nav op without line/column → self-correcting error', async () => {
    const r = await LspTool.call({ op: 'references', file: 'src/app.ts' }, ctx())
    expect(r.isError).toBe(true)
  })
  it('a path outside the project is rejected (ADR-033 confinement)', async () => {
    const r = await LspTool.call({ op: 'definition', file: '../escape.ts', line: 1, column: 1 }, ctx())
    expect(r.isError).toBe(true)
  })
})
