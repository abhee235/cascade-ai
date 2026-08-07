// The formatter exists because span payloads are JSON that is often TRUNCATED — the fold caps
// input/output at 4000 chars, so the long prompts most worth reading arrive cut mid-object. Anything
// built on JSON.parse would refuse exactly those.
import { describe, it, expect } from 'vitest'
import { formatJsonish, looksLikeJson } from '../src/components/observatory/format'

describe('Observatory payload formatter (ADR-081)', () => {
  it('offers itself for objects and arrays, not for prose', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true)
    expect(looksLikeJson('  [1,2]')).toBe(true)
    expect(looksLikeJson('(tools: AskUserQuestion)')).toBe(false)
    expect(looksLikeJson('Wrote 1155 chars to PLAN.md')).toBe(false)
  })

  it('indents structure', () => {
    expect(formatJsonish('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
  })

  it('formats TRUNCATED json — the case JSON.parse cannot handle', () => {
    // A real prompt, cut by the fold's 4000-char cap. Unbalanced braces, trailing comma, and it still
    // has to render: this is the payload the user actually wants to read.
    const cut = '[{"role":"assistant","content":[{"type":"thinking","thinking":"Planning"},{"type":"tool_use","name":"Skill","input":{"name":"architecture"'
    const out = formatJsonish(cut)
    expect(out).toContain('"role": "assistant"')
    expect(out).toContain('"name": "architecture"')
    expect(out.split('\n').length).toBeGreaterThan(5) // genuinely broken up, not one line
  })

  it('expands escaped newlines inside strings — the whole point for file contents', () => {
    // A Write tool's input is a file. As one escaped line it is unreadable; this is a VIEW, and Copy
    // still hands over the untouched original.
    const out = formatJsonish('{"file_path":"PLAN.md","content":"# Todo\\n\\n## Goal\\nLocal-first"}')
    expect(out).toContain('# Todo\n')
    expect(out).toContain('## Goal\nLocal-first')
  })

  it('does not mistake punctuation INSIDE a string for structure', () => {
    // A brace or comma in prose must not indent, and an escaped quote must not end the string early.
    const out = formatJsonish('{"msg":"a {brace}, a comma and an escaped \\" quote"}')
    expect(out).toBe('{\n  "msg": "a {brace}, a comma and an escaped \\" quote"\n}')
  })

  it('leaves an already-broken string alone rather than throwing', () => {
    expect(() => formatJsonish('{"a":"unterminated')).not.toThrow()
    expect(() => formatJsonish('')).not.toThrow()
  })
})
