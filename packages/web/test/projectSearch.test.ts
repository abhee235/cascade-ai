// The sidebar's Recent-projects list: search matching, and how many rows the incremental window renders.
//
// The bug this replaces: NavSidebar did projects.slice(0, 12), so project 13 onward could not be reached from
// the rail at all, and there was no way to search it. The list now renders a page at a time and filters with
// the same matcher the Projects page uses.
import { describe, expect, it } from 'vitest'
import { matchesProjectQuery } from '../src/lib/projectSearch'
import { windowCount } from '../src/lib/incrementalList'

// Real names from this app: they are prompt-derived, long, quoted and punctuated.
const NORTHLINE = "Build 'Northline Supply', a premium outdoor gear store"
const VELOCARTA = 'Act as an expert UX/UI designer. Build "Velocarta" — a premium bike accessories store.'

describe('matchesProjectQuery', () => {
  it('an empty or whitespace-only query matches everything', () => {
    expect(matchesProjectQuery(NORTHLINE, '')).toBe(true)
    expect(matchesProjectQuery(NORTHLINE, '   ')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesProjectQuery(NORTHLINE, 'NORTHLINE')).toBe(true)
    expect(matchesProjectQuery(NORTHLINE, 'northline')).toBe(true)
  })

  it('a single word behaves like the old substring match — including partial words', () => {
    expect(matchesProjectQuery(VELOCARTA, 'velo')).toBe(true)
    expect(matchesProjectQuery(VELOCARTA, 'carta')).toBe(true)
    expect(matchesProjectQuery(VELOCARTA, 'northline')).toBe(false)
  })

  it('multi-word queries match in ANY order, across the quotes and commas between the words', () => {
    // The whole point on prompt-derived names: nobody remembers "'Northline Supply'," verbatim.
    expect(matchesProjectQuery(NORTHLINE, 'supply northline')).toBe(true)
    expect(matchesProjectQuery(NORTHLINE, 'northline gear')).toBe(true)
  })

  it('every word must be present — it narrows, it does not widen', () => {
    expect(matchesProjectQuery(NORTHLINE, 'northline bike')).toBe(false)
  })

  it('ignores diacritics in both directions', () => {
    expect(matchesProjectQuery("Build 'Café Luna', a menu site", 'cafe')).toBe(true)
    expect(matchesProjectQuery('Build a cafe menu site', 'café')).toBe(true)
  })

  it('tolerates runs of whitespace between query words', () => {
    expect(matchesProjectQuery(NORTHLINE, '  northline    supply ')).toBe(true)
  })
})

describe('windowCount — rows rendered by the incremental list', () => {
  it('renders the first page when the list is longer than it', () => {
    expect(windowCount(24, 100)).toBe(24)
  })

  it('never exceeds the list — a short list renders fully', () => {
    expect(windowCount(24, 7)).toBe(7)
    expect(windowCount(24, 0)).toBe(0)
  })

  it('widens to include a pinned row below the window (the open project, or one with a turn running)', () => {
    // Project #80 is open: its highlight — and a building/awaiting dot — must exist in the DOM.
    expect(windowCount(24, 100, [79])).toBe(80)
  })

  it('uses the DEEPEST pinned row when several are pinned', () => {
    expect(windowCount(24, 100, [30, 61])).toBe(62)
  })

  it('ignores findIndex misses (-1), so an unmatched pin never shrinks or breaks the window', () => {
    expect(windowCount(24, 100, [-1, -1])).toBe(24)
    expect(windowCount(24, 100, [-1, 40])).toBe(41)
  })

  it('a pin already inside the window changes nothing', () => {
    expect(windowCount(24, 100, [3])).toBe(24)
  })

  it('a pin can never push the count past the end of the list', () => {
    expect(windowCount(24, 10, [50])).toBe(10)
  })
})
