// workerPool.ts — a small fixed-size web-worker pool. M1 ships the pool itself; offloading syntax
// highlighting / markdown / search to workers is wired in later milestones (Code pane, heavy diff
// rendering).

interface PoolTask<T> {
  payload: unknown
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export class WorkerPool<T = unknown> {
  private slots: { worker: Worker; busy: boolean }[] = []
  private queue: PoolTask<T>[] = []
  private readonly size: number

  constructor(
    private readonly workerFactory: () => Worker,
    size = navigator.hardwareConcurrency ?? 2,
  ) {
    this.size = Math.min(size, 4) // cap threads
  }

  private slot() {
    if (this.slots.length < this.size) {
      const worker = this.workerFactory()
      worker.onmessage = (e) => this.onDone(worker, e.data)
      const s = { worker, busy: false }
      this.slots.push(s)
      return s
    }
    return this.slots.find((s) => !s.busy)
  }

  private current = new Map<Worker, PoolTask<T>>()

  private onDone(worker: Worker, data: T) {
    const task = this.current.get(worker)
    this.current.delete(worker)
    const s = this.slots.find((x) => x.worker === worker)
    if (s) s.busy = false
    task?.resolve(data)
    const next = this.queue.shift()
    if (next) this.run(next)
  }

  private run(task: PoolTask<T>) {
    const s = this.slot()
    if (!s) return void this.queue.push(task)
    s.busy = true
    this.current.set(s.worker, task)
    s.worker.postMessage(task.payload)
  }

  exec(payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => this.run({ payload, resolve, reject }))
  }

  dispose() {
    for (const s of this.slots) s.worker.terminate()
    this.slots = []
    this.queue = []
  }
}
