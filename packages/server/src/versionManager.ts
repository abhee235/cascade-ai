// versionManager.ts — git checkpoints / restore (M6). Each agent turn that changes files is committed as a
// checkpoint in the project's git repo (baseline commit lands at create). The UI lists checkpoints and can
// restore the working tree to any of them. Server-only (a wrapper concern); surfaced as BuilderEvents — core
// knows nothing about versions. The agent edits files in the bind-mounted dir, so host git sees the changes.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Version } from '@cascade/app-protocol'

const US = '\x1f' // unit separator — safe field delimiter for `git log --format`
// Commit as Cascade so checkpoints don't depend on the host's global git identity (matches gitInit).
const IDENT = ['-c', 'user.name=Cascade', '-c', 'user.email=cascade@local']

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })

const samePath = (a: string, b: string) => resolve(a).replace(/\\/g, '/').toLowerCase() === resolve(b).replace(/\\/g, '/').toLowerCase()

export class VersionManager {
  /** Is `dir` its OWN git repo root — not a subdirectory of a PARENT repo? This is the whole safety of this
   *  module. If a project's gitInit failed at create, `dir` has no `.git`, and every git command run here
   *  (`add -A`, `reset --hard`, `log`) silently WALKS UP to the enclosing repo. Measured 2026-07-23: a build
   *  checkpoint for such a project committed the developer's own main-repo work-in-progress under the Cascade
   *  identity; a `restore` would have `reset --hard`'d it — destroying uncommitted work. So every operation
   *  gates on this. */
  private ownsRepo(dir: string): boolean {
    try {
      return samePath(git(dir, ['rev-parse', '--show-toplevel']).trim(), dir)
    } catch {
      return false // not inside any repo
    }
  }

  /** Keep CASCADE's own metadata out of the USER's project history. `.cascade/` holds the forensic traces
   *  (measured 2026-09-25: a single builder trace at 14 MB), dev.log and todos.json — none of it is the
   *  user's work, yet `git add -A` below was committing all of it into every checkpoint, so each turn wrote
   *  multi-megabyte blobs into a repo the user may later push. Idempotent and best-effort: append the ignore
   *  rule when absent, and drop anything already tracked from the INDEX only — files on disk are untouched,
   *  so a running build's open trace keeps writing normally. Never throws: housekeeping must not be able to
   *  cost the user a checkpoint. */
  private ensureCascadeIgnored(dir: string): void {
    try {
      const gitignore = join(dir, '.gitignore')
      const body = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
      if (!/^\.cascade\/?\s*$/m.test(body)) {
        writeFileSync(gitignore, `${body}${body && !body.endsWith('\n') ? '\n' : ''}.cascade/\n`)
      }
      // Only touch the index when something is actually tracked — keeps the common path a single cheap read.
      if (git(dir, ['ls-files', '.cascade']).trim()) git(dir, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '.cascade'])
    } catch {
      /* housekeeping is never worth failing a checkpoint over */
    }
  }

  /** Commit the current working tree as a checkpoint (no-op if nothing changed). Returns true if it committed. */
  checkpoint(dir: string, message: string): boolean {
    try {
      if (!this.ownsRepo(dir)) {
        // The project isn't its own repo (gitInit failed). Init it as one — WITHOUT this, `git add -A` below
        // would stage and commit the PARENT repo. If init doesn't take, refuse rather than touch a parent.
        try {
          git(dir, ['init', '-q'])
        } catch {
          /* git init failed — fall through to the guard */
        }
        if (!this.ownsRepo(dir)) return false
      }
      this.ensureCascadeIgnored(dir) // before `add -A` — that is what was sweeping traces into history
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
      if (!this.ownsRepo(dir)) return [] // never surface a PARENT repo's commits as this project's checkpoints
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
      if (!this.ownsRepo(dir)) return false // NEVER `reset --hard` a parent repo — that would wipe real work
      git(dir, ['reset', '--hard', id])
      return true
    } catch {
      return false
    }
  }
}
