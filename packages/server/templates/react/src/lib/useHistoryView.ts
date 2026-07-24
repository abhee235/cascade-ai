// useHistoryView — view-union navigation that ALSO drives the browser's history, so back/forward work (the
// browser's buttons AND Cascade's preview toolbar) without a router or any new dependency.
//
// It's a drop-in for useState: swap the top-level `view` state over and every setView both updates the view
// AND pushes a history entry. Walking back/forward restores the matching view via `popstate`. Use it for the
// ONE top-level view union in App — not for local component state.
//
//   const [view, setView] = useHistoryView<View>('list')   // was useState<View>('list')
//
// `View` may be a string ('list') or an object union ({ kind: 'detail', id }) — the value is stored in
// history.state (structured-cloned), so keep it serializable (no functions/DOM nodes).

import { useCallback, useEffect, useState } from 'react'

export function useHistoryView<T>(initial: T): [T, (next: T) => void] {
	const [view, setView] = useState<T>(initial)

	const go = useCallback((next: T) => {
		setView(next)
		history.pushState({ __view: next }, '')
	}, [])

	useEffect(() => {
		// Seed the first entry so the FIRST Back restores the initial view instead of leaving the app.
		history.replaceState({ __view: initial }, '')
		const onPop = (e: PopStateEvent) => {
			const s = e.state as { __view?: T } | null
			setView(s && '__view' in s ? (s.__view as T) : initial)
		}
		window.addEventListener('popstate', onPop)
		return () => window.removeEventListener('popstate', onPop)
		// `initial` is a mount-time constant; intentionally subscribe once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return [view, go]
}
