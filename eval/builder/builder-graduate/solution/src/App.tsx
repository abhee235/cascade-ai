// Inkwell — a small notes app. Persistence goes through the seam (createStore from @/lib/storage), which
// is now API-backed after graduation. No component reads or writes localStorage directly.

import { useEffect, useState } from 'react'
import { createStore } from '@/lib/storage'
import { SEED_NOTES } from '@/lib/data'
import type { Note, NoteColor } from '@/lib/types'

const noteStore = createStore<Note>('notes', SEED_NOTES)

const COLORS: NoteColor[] = ['red', 'amber', 'green', 'blue']
const SWATCH: Record<NoteColor, string> = {
	red: 'bg-red-100 border-red-300',
	amber: 'bg-amber-100 border-amber-300',
	green: 'bg-green-100 border-green-300',
	blue: 'bg-blue-100 border-blue-300',
}

function useNotes() {
	const [notes, setNotes] = useState<Note[]>(() => noteStore.list())
	useEffect(() => {
		// API-backed store: pull the latest from the server on mount (no-op for the localStorage seam).
		const s = noteStore as { refresh?: () => Promise<Note[]> }
		s.refresh?.().then((fresh) => setNotes(fresh)).catch(() => {})
	}, [])
	const add = (n: Omit<Note, 'id'>) => {
		const created = noteStore.create({ ...n, id: Math.max(0, ...noteStore.list().map((x) => x.id)) + 1 })
		setNotes(noteStore.list())
		return created
	}
	const remove = (id: number) => {
		noteStore.remove(id)
		setNotes(noteStore.list())
	}
	return { notes, add, remove }
}

export default function App() {
	const { notes, add, remove } = useNotes()
	const [title, setTitle] = useState('')
	const [body, setBody] = useState('')
	const [color, setColor] = useState<NoteColor>('blue')

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!title.trim()) return
		add({ title: title.trim(), body: body.trim(), color })
		setTitle('')
		setBody('')
		setColor('blue')
	}

	return (
		<div className="mx-auto max-w-4xl p-6">
			<h1 className="mb-6 text-2xl font-semibold tracking-tight">Inkwell</h1>

			<form onSubmit={submit} className="mb-8 space-y-3 rounded-lg border p-4">
				<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="w-full rounded-md border px-3 py-2" />
				<textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a note…" className="w-full rounded-md border px-3 py-2" />
				<div className="flex items-center gap-2">
					{COLORS.map((c) => (
						<button key={c} type="button" onClick={() => setColor(c)} className={`h-6 w-6 rounded-full border-2 ${SWATCH[c]} ${color === c ? 'ring-2 ring-offset-2' : ''}`} aria-label={c} />
					))}
					<button type="submit" className="ml-auto rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
						Add note
					</button>
				</div>
			</form>

			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{notes.map((n) => (
					<div key={n.id} className={`rounded-lg border p-4 ${SWATCH[n.color]}`}>
						<div className="flex items-start justify-between gap-2">
							<h2 className="font-medium">{n.title}</h2>
							<button onClick={() => remove(n.id)} className="text-xs text-neutral-500 hover:text-neutral-900" aria-label="Delete note">
								Delete
							</button>
						</div>
						<p className="mt-1 text-sm text-neutral-700">{n.body}</p>
					</div>
				))}
			</div>
		</div>
	)
}
