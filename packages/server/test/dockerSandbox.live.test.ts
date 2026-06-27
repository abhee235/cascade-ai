// Docker-gated integration test — runs ONLY with CASCADE_DOCKER=1 (like the live-embeddings test), so the
// default `npm test` stays deterministic and Docker-free. Verifies real container exec + that the mounted
// project dir is the isolation boundary.
//
//   CASCADE_DOCKER=1 npx vitest run packages/server/test/dockerSandbox.live.test.ts

import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerSandbox } from '../src/dockerSandbox'

const RUN = process.env.CASCADE_DOCKER === '1'

describe.skipIf(!RUN)('DockerSandbox (live; CASCADE_DOCKER=1)', () => {
  it('runs a command in the container and streams its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-dsbx-'))
    const sbx = new DockerSandbox(dir, 'alpine')
    try {
      const chunks: string[] = []
      const { output, exitCode } = await sbx.exec('echo hi-from-container', { onData: (c) => chunks.push(c) })
      expect(exitCode).toBe(0)
      expect(output).toContain('hi-from-container')
      expect(chunks.join('')).toContain('hi-from-container') // streamed live
    } finally {
      await sbx.dispose()
    }
  }, 60_000)

  it('commands run in /workspace (the mounted project dir), not the host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-dsbx-'))
    const sbx = new DockerSandbox(dir, 'alpine')
    try {
      const { output } = await sbx.exec('pwd')
      expect(output.trim()).toBe('/workspace')
    } finally {
      await sbx.dispose()
    }
  }, 60_000)

  it('a file written inside the container appears in the host project dir (the isolation boundary)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-dsbx-'))
    const sbx = new DockerSandbox(dir, 'alpine')
    try {
      await sbx.exec('echo made-in-container > out.txt')
      expect(existsSync(join(dir, 'out.txt'))).toBe(true)
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toContain('made-in-container')
    } finally {
      await sbx.dispose()
    }
  }, 60_000)

  it('a nonzero exit is reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-dsbx-'))
    const sbx = new DockerSandbox(dir, 'alpine')
    try {
      const { exitCode } = await sbx.exec('exit 7')
      expect(exitCode).toBe(7)
    } finally {
      await sbx.dispose()
    }
  }, 60_000)
})
