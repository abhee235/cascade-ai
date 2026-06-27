// streamingOptimizer.ts — batch high-frequency stream chunks per animation frame so the UI doesn't
// re-render on every token.
//
// We render the final answer whole (ADR-013), but tool-progress and per-file edit deltas still stream;
// this keeps those at 60fps by coalescing chunks and flushing once per rAF (or after maxDelay ms).

export class StreamingOptimizer {
  private buffer = ''
  private rafId: number | null = null
  private lastFlush = 0

  constructor(
    private readonly onFlush: (text: string) => void,
    private readonly maxDelay = 50,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk
    if (this.rafId !== null) return // a flush is already scheduled

    const overdue = performance.now() - this.lastFlush >= this.maxDelay
    if (overdue) {
      this.flush() // latency would build up — flush now
    } else {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null
        this.flush()
      })
    }
  }

  /** Force any buffered text out immediately (e.g. on turn end). */
  flush(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.lastFlush = performance.now()
    this.onFlush(text)
  }
}
