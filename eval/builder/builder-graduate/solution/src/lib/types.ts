export type NoteColor = 'red' | 'amber' | 'green' | 'blue'

export interface Note {
	id: number
	title: string
	body: string
	color: NoteColor
}
