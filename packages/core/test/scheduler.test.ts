import { describe, it, expect } from 'vitest'
import { partition } from '../src/tools/scheduler'
import type { ToolUse } from '../src/tools/runTool'

const tu = (id: string, name: string): ToolUse => ({ id, name, input: {} })
const ids = (batches: ToolUse[][]) => batches.map((b) => b.map((t) => t.id))

describe('scheduler.partition', () => {
  it('groups consecutive read-only tools into one parallel batch', () => {
    expect(ids(partition([tu('1', 'Read'), tu('2', 'Grep'), tu('3', 'Glob')]))).toEqual([['1', '2', '3']])
  })

  it('runs each write in its own serial batch', () => {
    expect(ids(partition([tu('1', 'Write'), tu('2', 'Edit')]))).toEqual([['1'], ['2']])
  })

  it('splits a safe run when a write interrupts, preserving order', () => {
    expect(ids(partition([tu('1', 'Read'), tu('2', 'Read'), tu('3', 'Write'), tu('4', 'Grep')]))).toEqual([
      ['1', '2'],
      ['3'],
      ['4'],
    ])
  })

  it('treats unknown tools as unsafe (solo)', () => {
    expect(ids(partition([tu('1', 'Read'), tu('2', 'Nope')]))).toEqual([['1'], ['2']])
  })
})
