// versionManager.ts — git checkpoints / restore (M6). Each agent turn that changes files is committed as a
// checkpoint in the project's git repo (baseline commit lands at create). The UI lists checkpoints and can
// restore the working tree to any of them. Server-only (a wrapper concern); surfaced as BuilderEvents — core
// knows nothing about versions. The agent edits files in the bind-mounted dir, so host git sees the changes.

import { execFileSync } from 'node:child_process'
import type { Version } from '@cascade/app-protocol'

const US = '\x1f' // unit separator — safe field delimiter for `git log --format`
// Commit as Cascade so checkpoints don't depend on the host's global git identity (matches gitInit).
const IDENT = ['-c', 'user.name=Cascade', '-c', 'user.email=cascade@local']

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })

export class VersionManager {
  /** Commit the current working tree as a checkpoint (no-op if nothing changed). Returns true if it committed. */
  checkpoint(dir: string, message: string): boolean {
    try {
      git(dir, ['add', '-A'])
      if (!git(dir, ['status', '--porcelain']).trim()) return false // nothing changed
      const subject = (message.replace(/\s+/g, ' ').trim() || 'Checkpoint').slice(0, 72)
      git(dir, [...IDENT, 'commit', '-q', '-m', subject])
      return true
    } catch {
      return false // git missing / not a repo — never break the turn
    }
  }

  /** The checkpoint history (newest first), reachable from HEAD. */
  list(dir: string): Version[] {
    try {
      const out = git(dir, ['log', `--format=%H${US}%s${US}%cI`, '-n', '100'])
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, summary, createdAt] = line.split(US)
          return { id, summary, createdAt }
        })
    } catch {
      return []
    }
  }

  /** Restore the working tree to a checkpoint (hard rewind). Later checkpoints drop off HEAD (classic undo);
   *  the objects survive in the reflog. Returns true on success. */
  restore(dir: string, id: string): boolean {
    try {
      git(dir, ['reset', '--hard', id])
      return true
    } catch {
      return false
    }
  }
}
