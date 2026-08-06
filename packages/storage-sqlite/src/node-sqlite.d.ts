// Local declaration for `node:sqlite`. The repo pins @types/node 20.x, but node:sqlite arrived in
// 22.5+ (Node 24 runs it here, and Electron ships its own Node). Declaring only the surface we use
// keeps this scoped to this package — a repo-wide @types/node bump would ripple through core/server
// for no benefit. Delete this file when the repo moves to @types/node >= 22.5.
declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
