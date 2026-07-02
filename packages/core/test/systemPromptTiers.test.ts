import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt } from '../src/agent/systemPrompt'
import { windowTier, contextWindowForModel } from '../src/llm/contextWindows'
import { resolveCompactionPlan } from '../src/context/compactor'
import { defaultRegistry } from '../src/tools/toolRegistry'

const cwd = mkdtempSync(join(tmpdir(), 'sysprompt-'))

describe('windowTier — 128k is its own band, distinct from 32k (ADR-037)', () => {
  it('maps windows to the right tier', () => {
    expect(windowTier(8_192)).toBe('minimal')
    expect(windowTier(16_000)).toBe('minimal')
    expect(windowTier(32_768)).toBe('lean') // qwen36-agentic
    expect(windowTier(65_536)).toBe('lean')
    expect(windowTier(131_072)).toBe('full') // coding-qwen36 — full behavioural prompt
    expect(windowTier(200_000)).toBe('full')
  })
  it('boundaries', () => {
    expect(windowTier(23_999)).toBe('minimal')
    expect(windowTier(24_000)).toBe('lean')
    expect(windowTier(95_999)).toBe('lean')
    expect(windowTier(96_000)).toBe('full')
  })
})

describe('coding-qwen36 window fix (was mis-read as 32k)', () => {
  it('resolves to 128k → full tier, compacts late (not at 22k)', () => {
    expect(contextWindowForModel('coding-qwen36:latest')).toBe(131_072)
    expect(contextWindowForModel('qwen36-agentic:latest')).toBe(32_768) // sibling still 32k — not clobbered
    const plan = resolveCompactionPlan({ model: 'coding-qwen36:latest' })
    expect(plan.window).toBe(131_072)
    expect(plan.tier).toBe('full')
    expect(plan.auto).toBeGreaterThan(90_000) // absolute branch (≈95k), not ~22k as a mis-sized 32k would give
  })
})

describe('buildSystemPrompt tiers select behavioural sections (ADR-037)', () => {
  it('full: the whole behavioural core', () => {
    const p = buildSystemPrompt({ cwd, tier: 'full' })
    expect(p).toMatch(/Read before you change/)
    expect(p).toMatch(/Verify before you claim done/)
    expect(p).toMatch(/Report faithfully/)
    expect(p).toMatch(/# Using your tools/)
    expect(p).toMatch(/# Acting with care/) // full-only section
    expect(p).toMatch(/system-reminder/)
    expect(p).toMatch(new RegExp(cwd.replace(/\\/g, '\\\\')))
  })
  it('lean: keeps the load-bearing rules, drops the risk-actions detail', () => {
    const p = buildSystemPrompt({ cwd, tier: 'lean' })
    expect(p).toMatch(/# Doing tasks/)
    expect(p).toMatch(/Read before you change/) // still present (condensed)
    expect(p).not.toMatch(/# Acting with care/) // dropped at lean
    expect(p).toMatch(/# Environment/)
  })
  it('minimal: a compact digest, not the full sections', () => {
    const p = buildSystemPrompt({ cwd, tier: 'minimal' })
    expect(p).toMatch(/# Core rules/)
    expect(p).not.toMatch(/# Doing tasks/)
    expect(p).not.toMatch(/# Acting with care/)
    expect(p.length).toBeLessThan(buildSystemPrompt({ cwd, tier: 'full' }).length)
  })
  it('defaults to full when no tier is given', () => {
    expect(buildSystemPrompt({ cwd })).toMatch(/# Acting with care/)
  })
  it('subagent flag adds the "you are a subagent" framing (G8)', () => {
    expect(buildSystemPrompt({ cwd, subagent: true })).toMatch(/# You are a subagent/)
    expect(buildSystemPrompt({ cwd, subagent: false })).not.toMatch(/# You are a subagent/)
  })
})

describe('tool descriptions are tier-sized through the registry (ADR-037)', () => {
  it('Bash advertises rich guidance on full, essentials on minimal', () => {
    const bashAt = (tier: 'minimal' | 'lean' | 'full') =>
      defaultRegistry.schemas(tier).find((s) => s.name === 'Bash')!.description
    expect(bashAt('full')).toMatch(/Git safety/) // rich: full git-safety protocol
    expect(bashAt('lean')).toMatch(/no --amend/i) // condensed but rules retained
    expect(bashAt('minimal')).toMatch(/never destructive/i) // essentials only
    expect(bashAt('minimal').length).toBeLessThan(bashAt('lean').length)
    expect(bashAt('lean').length).toBeLessThan(bashAt('full').length)
  })
  it('plain-string descriptions pass through unchanged at every tier (MCP compatibility)', () => {
    const readFull = defaultRegistry.schemas('full').find((s) => s.name === 'Read')!.description
    const readMin = defaultRegistry.schemas('minimal').find((s) => s.name === 'Read')!.description
    expect(readMin).toBe(readFull)
    // no-arg call (headless smokes) defaults to full
    expect(defaultRegistry.schemas().find((s) => s.name === 'Bash')!.description).toMatch(/Git safety/)
  })
  it('TodoWrite is tiered but keeps ALL FOUR rules at every tier (load-bearing)', () => {
    const at = (tier: 'minimal' | 'lean' | 'full') =>
      defaultRegistry.schemas(tier).find((s) => s.name === 'TodoWrite')!.description
    expect(at('lean').length).toBeLessThan(at('full').length)
    for (const tier of ['minimal', 'lean', 'full'] as const) {
      const d = at(tier)
      expect(d).toMatch(/in_progress/) // one in_progress before working
      expect(d).toMatch(/completed/i) // mark completed immediately
      expect(d).toMatch(/ENTIRE list/) // always resend the full list
    }
  })
  it('load-bearing descriptions (Edit/Read/Write) stay IDENTICAL at every tier — deliberate', () => {
    for (const name of ['Edit', 'Read', 'Write']) {
      const full = defaultRegistry.schemas('full').find((s) => s.name === name)!.description
      const min = defaultRegistry.schemas('minimal').find((s) => s.name === name)!.description
      expect(min).toBe(full) // cutting their rules causes failed-edit retry loops that cost more than the words
    }
    // and the rules themselves are present
    const edit = defaultRegistry.schemas('minimal').find((s) => s.name === 'Edit')!.description
    expect(edit).toMatch(/EXACTLY ONCE/)
    expect(edit).toMatch(/N→/) // the line-number-prefix warning survives every tier
  })
})

rmSync(cwd, { recursive: true, force: true })
