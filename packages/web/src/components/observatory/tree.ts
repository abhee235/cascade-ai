// tree.ts — fold a FLAT span list into a forest (ADR-081).
//
// Kept out of the component (and free of React/alias imports) because this is logic, not rendering: it
// decides what a trace LOOKS like, and it is the part with edge cases worth testing.
//
// The wire carries spans flat and the client nests them, deliberately. Nesting server-side would mean a
// span whose parent is missing takes its whole subtree down with it — and during a LIVE turn, which is
// exactly when this page earns its keep, a not-yet-flushed parent is the normal state, not an anomaly.

import type { SpanInfo } from '@cascade/app-protocol'

export interface TreeNode {
  span: SpanInfo
  children: TreeNode[]
}

/**
 * Two properties matter more than elegance:
 *  - ORPHANS ARE KEPT. A span naming a parent we don't have becomes a root rather than disappearing.
 *  - CYCLES CANNOT HANG IT. Ids come from a store, not from us; a self- or mutual-parent would otherwise
 *    recurse forever during render. Any span that would close a loop is demoted to a root.
 *
 * Siblings sort by start time, so the tree reads top-to-bottom in the order things actually happened.
 */
export function buildForest(spans: SpanInfo[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>()
  for (const span of spans) nodes.set(span.spanId, { span, children: [] })

  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const parentId = node.span.parentSpanId
    const parent = parentId ? nodes.get(parentId) : undefined
    if (!parent || parent === node || createsCycle(node, parent, nodes)) roots.push(node)
    else parent.children.push(node)
  }

  const byStart = (a: TreeNode, b: TreeNode) => a.span.startedAt - b.span.startedAt
  const sortDeep = (n: TreeNode) => {
    n.children.sort(byStart)
    n.children.forEach(sortDeep)
  }
  roots.sort(byStart)
  roots.forEach(sortDeep)
  return roots
}

/** Would attaching `node` under `parent` close a loop? Walks parent's ancestry looking for `node`. */
function createsCycle(node: TreeNode, parent: TreeNode, nodes: Map<string, TreeNode>): boolean {
  const seen = new Set<string>()
  let cur: TreeNode | undefined = parent
  while (cur) {
    if (cur === node || seen.has(cur.span.spanId)) return true
    seen.add(cur.span.spanId)
    cur = cur.span.parentSpanId ? nodes.get(cur.span.parentSpanId) : undefined
  }
  return false
}

/** Total spans beneath a node (not counting itself) — the "+N" badge on a collapsed row. */
export const countDescendants = (n: TreeNode): number => n.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0)

/** The trace's own window: MIN start → MAX end across every span, so the timeline is scaled by what
 *  actually happened rather than by the root span, which may commit before its late children. */
export function traceWindow(spans: SpanInfo[]): { start: number; ms: number } {
  if (!spans.length) return { start: 0, ms: 1 }
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (const s of spans) {
    if (s.startedAt < start) start = s.startedAt
    const e = s.endedAt ?? s.startedAt
    if (e > end) end = e
  }
  return { start, ms: Math.max(1, end - start) }
}
