import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 text-neutral-100">
      <h1 className="text-4xl font-bold tracking-tight">Your app starts here</h1>
      <p className="text-neutral-400">Edit <code className="rounded bg-neutral-800 px-1.5 py-0.5">src/App.tsx</code> and ask Cascade to build something.</p>
      <button
        className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white transition hover:bg-blue-500"
        onClick={() => setCount((c) => c + 1)}
      >
        count is {count}
      </button>
    </main>
  )
}
