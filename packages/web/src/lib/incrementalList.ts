// incrementalList.ts — render a long list a page at a time, loading the next page when the user scrolls near
// the bottom. The data is already in memory; what this saves is DOM: mounting every row up front is what makes
// a sidebar with hundreds of projects slow to open and sluggish to scroll.

import { type RefObject, useEffect, useState } from 'react'

/**
 * How many rows to render: the window the user has scrolled open, widened so that rows which must stay
 * visible are rendered even when they sit deeper than that window.
 *
 * Pinning is not cosmetic. The sidebar's rows carry state you navigate BY — the open project is highlighted,
 * and the project with a turn running shows the building/awaiting-approval dot (ADR-068) that exists so you
 * can get back to it from anywhere. Windowing those rows out of the DOM would silently delete both
 * affordances for any project older than the first page. Negative indices (a findIndex miss) are ignored.
 */
export function windowCount(limit: number, total: number, pinnedIndices: readonly number[] = []): number {
  let deepest = -1
  for (const i of pinnedIndices) if (i > deepest) deepest = i
  return Math.max(0, Math.min(total, Math.max(limit, deepest + 1)))
}

interface Options {
  total: number
  pageSize: number
  /** Changing this snaps the window back to the first page — e.g. the search text. Compared with ===. */
  resetKey: string
  /** Indices that must be rendered even when they fall below the scrolled-to window. */
  pinnedIndices?: readonly number[]
  /** The scrolling ancestor. The sentinel is measured against IT rather than the viewport: an observer rooted
   *  at the viewport is still clipped by the scroll container, so its rootMargin could never pre-load. */
  rootRef?: RefObject<HTMLElement | null>
}

export function useIncrementalList({ total, pageSize, resetKey, pinnedIndices = [], rootRef }: Options) {
  // The window is stored WITH the key it belongs to, and a key change resets it during render (React's
  // "adjust state when a prop changes" pattern) rather than in an effect. With an effect there is a commit
  // where the new, shorter list renders at the OLD depth, and an observer callback already in flight can land
  // after the reset and re-expand it. Resetting during render means no stale window is ever committed.
  const [win, setWin] = useState({ key: resetKey, limit: pageSize })
  if (win.key !== resetKey) setWin({ key: resetKey, limit: pageSize })
  const limit = win.key === resetKey ? win.limit : pageSize

  const count = windowCount(limit, total, pinnedIndices)
  // Grow-only within a key: lock in any depth a pin opened. Without this the pin widens the RENDERED window
  // but never the stored one — so opening the oldest project renders all 100 rows, and the moment the pin
  // moves (click Home, click a shallower row, a background build finishes) rows 25-100 unmount under the
  // pointer, scrollTop gets clamped and the list jumps. Settles in one pass: next render count === limit.
  if (win.key === resetKey && count > win.limit) setWin({ key: resetKey, limit: count })
  const hasMore = count < total

  // A callback ref, not useRef: the sentinel mounts and unmounts as `hasMore` flips, and the observer has
  // to follow the element that actually exists.
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!sentinel || !hasMore) return
    const key = resetKey
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        // Ignore a callback that belongs to a previous search; grow from `count` so a pinned row that already
        // widened the window is not re-rendered as "the next page".
        setWin((w) => (w.key === key ? { key, limit: Math.max(w.limit, count) + pageSize } : w))
      },
      // 160px of look-ahead: the next page mounts just before the user reaches the end, so scrolling never
      // visibly stalls on an empty bottom.
      { root: rootRef?.current ?? null, rootMargin: '0px 0px 160px 0px' },
    )
    io.observe(sentinel)
    // Re-created whenever `count` changes, deliberately. observe() always delivers one initial callback with
    // the CURRENT state, which is what keeps loading on a tall screen: if the sentinel is still on-screen
    // after a page mounts, the fresh observer fires again, until the view is full or the list is exhausted.
    // A single long-lived observer would only fire on a change of state — and "still visible" is not one.
    return () => io.disconnect()
  }, [sentinel, hasMore, count, pageSize, resetKey, rootRef])

  return { count, hasMore, sentinelRef: setSentinel }
}
