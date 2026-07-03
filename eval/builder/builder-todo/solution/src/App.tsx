import { useState } from 'react'

export default function App() {
  const [items, setItems] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const add = () => {
    if (!draft.trim()) return
    setItems((xs) => [...xs, draft.trim()])
    setDraft('')
  }
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 text-neutral-100">
      <h1 className="text-4xl font-bold tracking-tight">Todos</h1>
      <div className="flex gap-2">
        <input
          className="rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100"
          placeholder="What needs doing?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="rounded-lg bg-blue-600 px-5 py-2 font-medium text-white" onClick={add}>
          Add
        </button>
      </div>
      <ul className="list-disc space-y-1 text-neutral-300">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </main>
  )
}
