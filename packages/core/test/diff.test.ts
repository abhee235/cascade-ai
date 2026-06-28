import { describe, it, expect } from 'vitest'
import { lineDiff } from '../src/utils/diff'

describe('lineDiff (M2 file-edit cards)', () => {
  it('marks context / removed / added lines', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc')
    expect(d).toContain(' a')
    expect(d).toContain('-b')
    expect(d).toContain('+B')
    expect(d).toContain(' c')
  })

  it('a new file is all additions', () => {
    expect(lineDiff('', 'x\ny')).toBe('+x\n+y')
  })

  it('no change ⇒ all context', () => {
    expect(lineDiff('a\nb', 'a\nb')).toBe(' a\n b')
  })
})
