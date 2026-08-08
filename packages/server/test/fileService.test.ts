import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, readTree, watchProjectTree } from '../src/fileService'

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

// ADR-081 — the Code pane's file watcher. Push-based refreshes only cover the agent's own edits; anything
// else (the terminal, a background install, a generator) changed the project with nothing to announce it.
describe('watchProjectTree', () => {
	const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

	it('fires when a real source file appears', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cascade-watch-'))
		let fired = 0
		const stop = watchProjectTree(dir, () => fired++)
		mkdirSync(join(dir, 'src'), { recursive: true })
		writeFileSync(join(dir, 'src', 'App.tsx'), 'export const App = () => null')
		await settle()
		stop()
		expect(fired).toBeGreaterThan(0)
	})

	it('IGNORES the noisy directories, or a dev server would refresh the tree per log line', async () => {
		// .cascade/dev.log is appended to constantly while a dev server runs, and node_modules churns for
		// thousands of files during an install. Watching them would turn one refresh into a firehose.
		const dir = mkdtempSync(join(tmpdir(), 'cascade-watch-'))
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
		await settle(150)
		let fired = 0
		const stop = watchProjectTree(dir, () => fired++)
		for (let i = 0; i < 20; i++) writeFileSync(join(dir, '.cascade', 'dev.log'), `line ${i}\n`)
		writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), 'x')
		await settle()
		stop()
		expect(fired).toBe(0)
	})

	it('stops firing once stopped, and stopping twice is safe', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cascade-watch-'))
		let fired = 0
		const stop = watchProjectTree(dir, () => fired++)
		stop()
		expect(() => stop()).not.toThrow()
		writeFileSync(join(dir, 'after.txt'), 'x')
		await settle()
		expect(fired).toBe(0)
	})
})
