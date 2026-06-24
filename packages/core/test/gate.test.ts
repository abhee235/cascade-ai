import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionState } from '../src/permissions/gate'
import type { Tool } from '../src/tools/Tool'

// checkPermission only reads tool.name and tool.isReadOnly, so minimal fakes keep this test pure.
const readTool = { name: 'Read', isReadOnly: () => true } as unknown as Tool
const writeTool = { name: 'Write', isReadOnly: () => false } as unknown as Tool
const st = (over: Partial<PermissionState> = {}): PermissionState => ({
  mode: 'default',
  allow: new Set(),
  deny: new Set(),
  ...over,
})

describe('checkPermission (mode → rules → capability)', () => {
  it('default mode: reads auto-allow, writes ask', () => {
    expect(checkPermission(readTool, {}, st())).toBe('allow')
    expect(checkPermission(writeTool, {}, st())).toBe('ask')
  })

  it('bypass mode allows everything (sandboxed frontend — no prompts)', () => {
    expect(checkPermission(writeTool, {}, st({ mode: 'bypass' }))).toBe('allow')
  })

  it('plan mode allows reads but denies writes', () => {
    expect(checkPermission(readTool, {}, st({ mode: 'plan' }))).toBe('allow')
    expect(checkPermission(writeTool, {}, st({ mode: 'plan' }))).toBe('deny')
  })

  it('acceptEdits mode auto-allows writes', () => {
    expect(checkPermission(writeTool, {}, st({ mode: 'acceptEdits' }))).toBe('allow')
  })

  it('a deny rule overrides the default ask', () => {
    expect(checkPermission(writeTool, {}, st({ deny: new Set(['Write']) }))).toBe('deny')
  })

  it('an allow rule turns ask into allow', () => {
    expect(checkPermission(writeTool, {}, st({ allow: new Set(['Write']) }))).toBe('allow')
  })
})
