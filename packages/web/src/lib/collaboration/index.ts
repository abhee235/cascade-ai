// collaboration/ — multiplayer presence/cursors/typing. DEFERRED (per plan): this is a SKELETON only.
// The seam exists so later milestones can implement it without restructuring; today it is inert.
//
// Reference shape: a socket + presence + permissions module.
// TODO(collab): real-time transport (WS room), presence broadcast, cursor/selection sync, annotations.

export interface Presence {
  userId: string
  name: string
  color: string
  cursor?: { line: number; col: number }
}

export interface CollaborationClient {
  readonly enabled: boolean
  join(room: string): void
  leave(): void
  peers(): Presence[]
  on(event: 'presence', cb: (peers: Presence[]) => void): () => void
}

/** No-op client. Swap for a real implementation when multiplayer is built. */
export const collaboration: CollaborationClient = {
  enabled: false,
  join() {},
  leave() {},
  peers: () => [],
  on: () => () => {},
}
