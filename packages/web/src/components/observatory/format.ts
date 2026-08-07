// format.ts — make a span's input/output readable without pretending it is a document.
//
// Span payloads are JSON far more often than not: an LLM's prompt is a messages array, a tool's input is
// its argument object. Shown raw they are a single unbroken line you scroll sideways through.
//
// The catch is that they are also TRUNCATED — the fold caps input/output at 4000 chars, so a long prompt
// arrives cut mid-object. A `JSON.parse`-based formatter would refuse precisely the payloads worth
// reading. So this formats STRUCTURALLY, character by character, and never needs the input to be valid.

/** Worth offering a formatted view? Cheap and deliberately loose — the formatter tolerates the rest. */
export function looksLikeJson(s: string): boolean {
  const t = s.trimStart()
  return t.startsWith('{') || t.startsWith('[')
}

/**
 * Indent on structure, expand escapes inside strings.
 *
 * Expanding `\n` inside a string makes the result invalid JSON, which is the right trade for a VIEW: the
 * payload you care about most is a file's contents or the model's reasoning, and both are unreadable as
 * one escaped line. Copy always yields the untouched original, so nothing is lost — you read here and
 * copy data elsewhere.
 */
export function formatJsonish(src: string): string {
  let out = ''
  let depth = 0
  let inStr = false
  let esc = false
  const indent = () => `\n${'  '.repeat(Math.max(0, depth))}`

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inStr) {
      if (esc) {
        // WHITESPACE escapes are expanded — that is the readability win, and what turns a file's contents
        // from one line into a file. Everything else is left escaped: unescaping \" would make the string
        // look like it ended two words early, which is worse than the escape it replaced.
        out += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '' : `\\${ch}`
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = false
      out += ch
      continue
    }

    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
      out += ch + indent()
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      out += indent() + ch
      continue
    }
    if (ch === ',') {
      out += ch + indent()
      continue
    }
    if (ch === ':') {
      out += ': '
      continue
    }
    // Collapse whitespace that sits BETWEEN tokens; whitespace inside strings was handled above.
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') continue
    out += ch
  }
  return out.replace(/\n\s*\n/g, '\n') // empty containers leave a blank line; close it up
}
