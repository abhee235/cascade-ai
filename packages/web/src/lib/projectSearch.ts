// projectSearch.ts — the ONE definition of "does this project match the search box". Shared by the sidebar's
// Recent-projects filter and the Projects page, so the two boxes can never disagree about what matches.

/** Lowercase and strip diacritics. Names are prompt-derived ("Build 'Café Luna', a …"), so typing "cafe"
 *  has to find it — nobody types the accent into a filter box. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * Every whitespace-separated word of the query must appear somewhere in the name, in any order.
 *
 * A single word behaves exactly like the plain substring match the Projects page used before. Several words
 * are what make it useful on prompt-derived names: "supply northline" finds "Build 'Northline Supply', a …"
 * without the user having to remember the word order, or the quote and comma sitting between the words.
 * An empty or all-whitespace query matches everything.
 */
export function matchesProjectQuery(name: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = fold(name)
  return words.every((w) => hay.includes(w))
}
