// winFenceSid.ts — deterministic capability SIDs for the Windows write-fence (ADR-070 step 6). PURE.
//
// The write-fence grants writes by naming a synthetic SID in the restricted token's restricting list AND
// on an ACE over the writable directory — a write clears only when BOTH allow it. These functions mint
// those SID strings. The workspace SID is DERIVED FROM THE CANONICAL PATH, so the same workspace always
// gets the same SID: its ACE materializes once per workspace per machine and STANDS (the reuse cache),
// and every later session/restart re-derives the identical SID and skips re-propagation. A per-session
// temp directory gets its own distinct SID, so sibling sessions sharing a workspace cannot write one
// another's temp trees. The SID string is not a secret — its power is exactly the ACEs that name it,
// which exist only on the trees we grant.
//
// Shape: S-1-4-<a>-<b> (SECURITY_NON_UNIQUE_AUTHORITY, two 30-bit subauthorities). The temp SID adds a
// fixed third subauthority to domain-separate it from every two-subauthority workspace SID.

import { createHash } from 'node:crypto'
import { canonicalPath } from '@cascade/core'

/** Two 30-bit subauthority values from a domain-separated hash of `input`. 30 bits keeps each value in the
 *  RID range every SID API accepts; +1 avoids a zero subauthority. */
function subauths(domain: string, input: string): [number, number] {
	const d = createHash('sha256').update(domain).update('\0').update(input).digest()
	const first = (d.readUInt32LE(0) % (2 ** 30 - 1)) + 1
	const second = (d.readUInt32LE(4) % (2 ** 30 - 1)) + 1
	return [first, second]
}

/** The per-workspace write SID (`S-1-4-a-b`) — same canonical path ⇒ same SID, forever. Callers MUST pass
 *  a path already canonicalized the way enforcement compares paths; we canonicalize again defensively so a
 *  raw spelling still converges (at the cost of one extra propagation if it differs). */
export function workspaceWriteSid(workspaceRoot: string): string {
	const [a, b] = subauths('cascade-workspace', canonicalPath(workspaceRoot))
	return `S-1-4-${a}-${b}`
}

/** The per-temp-directory write SID (`S-1-4-a-b-1`) — the random temp path is the identity; the trailing
 *  `1` domain-separates it from any workspace SID so the two can never collide. */
export function tempWriteSid(tempDir: string): string {
	const [a, b] = subauths('cascade-temp', canonicalPath(tempDir))
	return `S-1-4-${a}-${b}-1`
}
