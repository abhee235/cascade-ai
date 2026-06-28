// utils/diff.ts — a tiny line-based diff (LCS) for file-edit cards (M2) and, later, version diffs.
// Produces unified-ish lines prefixed with ' ' (context), '-' (removed), '+' (added). No deps.

export function lineDiff(before: string, after: string, maxOutLines = 240): string {
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  const n = a.length
  const m = b.length

  // Guard: skip the O(n·m) LCS for very large files — just show the new content as added.
  if (n > 2000 || m > 2000 || n * m > 2_000_000) {
    return cap(b.map((l) => `+${l}`), maxOutLines)
  }

  // LCS length table (bottom-up).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push(` ${a[i++]}`), j++
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${a[i++]}`)
    else out.push(`+${b[j++]}`)
  }
  while (i < n) out.push(`-${a[i++]}`)
  while (j < m) out.push(`+${b[j++]}`)
  return cap(out, maxOutLines)
}

function cap(lines: string[], max: number): string {
  return lines.length > max ? `${lines.slice(0, max).join('\n')}\n… (+${lines.length - max} more lines)` : lines.join('\n')
}
