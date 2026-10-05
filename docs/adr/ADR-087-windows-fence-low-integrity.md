# ADR-087 — The Windows write-fence at low integrity: the build must run inside the fence

**Status:** accepted 2026-09-29 (user-approved), branch `builder-design-quality`. **Amends** ADR-070's
`win-write-fence` rung (its mechanism for `workspace-write` and its denial dialect). Found while running ADR-086
P2; P2 re-runs on it.

## Context — measured 2026-09-28/29

- **P2's first run failed on the environment, not the design.** Qwen's first shop (`p2-qwen-react.stopped-0929`, React start)
  ran `npm run build` at turn 14 and got `Error: spawn EPERM` from vite's config loader. It spent the rest of
  that round (46 turns) and both follow-up rounds (60 and 28 turns) "repairing" the machine — `npm install @esbuild/…`, which deleted its
  `node_modules` junction ("Removing non-directory …\node_modules"), then a hand-written `scripts/tsc.cjs` and a
  rewritten build script — and hit the 60-minute cap. The follow-up text ("run `npm run build` until it is
  green") asked for something the model could not do. The batch was stopped (`eval/runs/p2-batch.log`).
- **Every fenced run that built has it.** The fence reached the builder bench with the 2026-09-27 merge. Since
  then every run that ran a build or install in its shell — **87 of 87**, Luna and Qwen; ADR-083's A/B, the
  oracle, ADR-086 P0 and P1 — got `spawn EPERM` (499 times); the two other fenced runs never tried. Before it,
  **0** of the 108 runs that built in their shell did (the last on 2026-08-27). No model in those 87 runs could run
  `vite build` itself. The bench's check builds outside the fence, so it never showed.
- **The mechanism** (reproduced with the runner, `--mode workspace-write`): under the `WRITE_RESTRICTED` token
  every child spawned with **piped** stdio fails; inherited stdio works (why `tsc` passed and `vite build` did
  not). Node (libuv) creates each stdio pipe as a *named* pipe with a NULL security descriptor, and the named-pipe
  file system gives it its own fixed default — Everyone: read; SYSTEM, Administrators and the owner: full — not
  the token's default DACL, so ADR-070's default-DACL merge never reaches it. No restricting SID (logon,
  Everyone, workspace) can write it; the second write check fails; `CreateFile` returns access denied → `spawn
  EPERM`. esbuild (vite's config loader and bundler), npm lifecycle scripts and every node child process spawn
  this way. ADR-070 listed "piped-stdio capture inside the fence fails for grandchildren" as a `partial`
  boundary; in practice it is the build.
- **The model was never told.** The fence's denial dialect is `access is denied` / `access to the path` /
  `permission denied`. Neither `spawn EPERM` nor node's `EPERM: operation not permitted` matches, so the Bash
  tool added no denial marker and no escalation hint — the model saw a broken toolchain.
- **Where it applies:** the product's default runtime is HostSandbox (ADR-081), `selectLocalBackend()` picks
  the fence wherever its probe passes, and a session with a sandbox runs `workspace-write`
  (`agentLoop.ts`). So every Windows user of the host runtime has this today; the WSL rung does not.

## Decision (proposed)

1. **`workspace-write` runs at low integrity instead of `WRITE_RESTRICTED`.** The runner derives the child token
   with `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN)` (no restricting SIDs) and lowers it to the
   Low mandatory level (`S-1-16-4096`). The workspace gets a standing, inheritable Low label (`S:(ML;OICI;NW;;;LW)`)
   in place of the workspace-SID write ACE: one tree propagation per workspace, cached exactly as the ACE is
   today. Windows' No-Write-Up policy then denies every write to an object not labeled low — the user's files,
   other folders, other processes — while the child's own new objects (its pipes, its files, its temp) are low,
   so piped spawns work.
2. **`read-only` keeps today's token** (`WRITE_RESTRICTED`, [logon SID, Everyone], medium integrity). At medium
   integrity the standing low label grants nothing and the second write check still denies, so mode downgrades
   stay free. Nothing builds in read-only mode.
3. **The denial dialect adds `operation not permitted` and `eperm`**, so a fenced write or spawn that node
   reports as EPERM carries the denial marker and the escalation hint, like `Access is denied.` does.
4. **Amendment (2026-10-06, user-approved): the label is held only while a project is open.** The final review
   found what decision 1 traded away: every labeled workspace carries the SAME low label, so a fenced command in
   project A could write project B — per-workspace SIDs had prevented that. Now a sandbox holds the label from its
   first fenced workspace-write command until it is disposed (project close, shutdown, the end of a bench run),
   counted per workspace so a second session keeps it; the last one out takes it off (one tree walk — measured,
   it revokes even files the low child created), and server startup sweeps labels a crashed run left. A fenced
   command can therefore write only the projects open at that moment — usually just its own.

## Evidence — prototype (`eval/.work/fence-proto/lowil.mts`, not product code)

On a copy of a kept React shop (`p1-react-4` shop-a2), labeled low, `node_modules` a junction to the shared
template install (as the bench makes it), TMP/TEMP and npm's cache in the workspace (as the runner sets them):

| Check | Today's fence (`workspace-write`, grant applied) | Low integrity |
|---|---|---|
| Spawn with piped stdio (esbuild's service, a node child) | `EPERM` | works |
| `npm run build` (`tsc -b && vite build`) | `tsc -b` passes, `vite build` → `spawn EPERM` | passes (built in 30 s) |
| `npm install` with a spawning step | `npm error code EPERM … syscall spawn` (P2 trace) | `npm install esbuild` (postinstall spawns the binary) passes; the binary then runs |
| Write inside the workspace | allowed | allowed |
| Write to the parent folder / the user profile | denied | denied (`Access is denied.`) |
| Write into the shared `node_modules` through the junction | denied | denied |

Label (and ACE) propagation does not follow junctions: after 87 fenced runs the shared install carries no
workspace-SID ACE.

## Security — today vs low integrity (measured, `eval/.work/fence-proto/security-matrix.ps1`)

| Effect of a fenced command | Today (`WRITE_RESTRICTED`) | Low integrity |
|---|---|---|
| Write the user's files outside the workspace (parent folder, profile) | denied | denied |
| Write a folder that grants Everyone full control (ADR-070's documented hole) | **allowed** | denied |
| Kill one of the user's own processes (`taskkill /F`) | denied | denied |
| Write HKCU (`Software\…`) | denied | denied |
| Write Windows' low-integrity areas (`AppData\LocalLow`, HKCU `Software\AppDataLow`) | denied | **allowed** |
| Another Cascade project's folder, from a fenced command | no (per-workspace SIDs) | only while that project is **open** too (decision 4; before it: always — found in the final review) |
| Its workspace, written by *other* low-integrity processes | no | **yes, while open** (few run at low; browsers' sandboxes run lower, in AppContainers) |
| Reads, network | open | open (unchanged — the rung stays `partial`) |
| Hard links out of the workspace | the documented hole | the same hole (the label, like the ACE, sits on the file object) |

Net: the Everyone hole closes; smaller exposures open — Windows' own low-integrity areas, and, while two
projects are open at once, each one's fenced commands can write the other (decision 4 confines this to open
projects); the rung's `partial` report states them. Old workspace ACEs stay and are inert (no token carries the
workspace SID any more).

## Implementation (each edit ≤ 100 lines; no server/core edit while a Cascade turn runs)

- `packages/server/src/winFence.ts` — `buildRestrictedToken`: `workspace-write` → the low-integrity token;
  `read-only` unchanged. `labelWorkspaceLow(dir)` (SDDL → SACL → `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)`)
  replaces `grantWriteAce` for this mode. Fail-closed as today: any Win32 failure → never spawn.
- `packages/server/src/sandboxBackends.ts` — `ensureWorkspaceGrant` → `ensureWorkspaceLabel` (same cache);
  the dialect gains `operation not permitted`, `eperm`. `winFenceRunner.ts` keeps its argv contract
  (`--write-sid` accepted, unused under the label).
- Tests: `winFence.live.test.ts` gains a piped-spawn test and a real `npm run build` inside the fence; the
  existing inside/outside/read-only/temp/dialect pins stay; the unit test pins the new dialect.
- ADR-070: the rung's mechanism paragraph and its `partial` list point here.

## Acceptance

1. The live suite on this machine: piped spawn, `npm run build` of the React template and `npm install` with a
   postinstall all pass under `workspace-write`; writes outside are denied **with** the denial marker; read-only
   still denies. All existing tests stay green.
2. One bench smoke (Luna, shop ×1): the model's own `npm run build` goes green in its shell — 0 `spawn EPERM`
   in the trace.
3. Then ADR-086 P2 re-runs as approved.

## Consequences for earlier results

ADR-083 → ADR-086 bench numbers were measured with a model that could not build in its own shell (checks built
outside the fence). Comparisons *within* a batch hold — every arm had the same handicap — but absolute solved
rates and "rounds to done" should move once models see their own vite errors. For P2 this means the oracle's A
arm (Qwen, fenced) is a handicapped baseline: HARD findings compare fairly, build failures favor the re-run. A
strict baseline — the A arm re-run on the fixed fence (the pre-ADR-086 product from `HEAD` plus this fix, 6
Qwen runs) — is optional and needs its own approval.

## Progress (2026-09-29)

**Built** (uncommitted, branch `builder-design-quality`):
- `winFence.ts`: the `workspace-write` token is our own, privileges stripped, lowered to Low (`setIntegrityLevel`); `read-only` is unchanged.
- `labelLowIntegrity` replaces `grantWriteAce`. It sets `S:(ML;OICI;NW;;;LW)` through `SetNamedSecurityInfoW` and skips a root that already carries it, so a restart no longer re-walks the tree. The default-DACL merge is removed.
- `winFenceRunner.ts` builds the token by mode; `--write-sid` is no longer required and is ignored if passed.
- `sandboxBackends.ts`: a label cache replaces the grant cache; the dialect gains `operation not permitted` and `eperm`; the probe now proves both modes (`workspace-write` is the default).
- `winFenceSid.ts` is deleted (no callers). A latent `grantWriteAce` bug went with it: its "union" comment was wrong, because a fresh one-ACE DACL *replaces* a folder's explicit ACEs.

**Tests:**
- The live suite gains four tests: a pre-existing tree gets labeled and the label stands; a `workspace-write` child spawns esbuild and node with piped stdio while read-only still cannot; cmd's and node's denials are classified end to end.
- The unit suite pins the dialect against the verbatim P2 messages.
- Full suite: 1,218 passed, 0 failed; all nine workspaces typecheck.

**Acceptance:**
1. **Product path — met.** Run through `HostSandbox.exec` under `workspace-write`, on a copy of a kept shop (`eval/.work/fence-proto/accept.mts`):
   - `npm run build` passes (65 s, `dist` written inside the workspace).
   - A write outside is denied and classified.
   - The shared install behind the junction stays unwritable.
   - `npm install esbuild`, whose postinstall spawns, passes, and the binary runs.
2. **Luna smoke (`adr087-smoke-luna`, shop ×1) — met.** Solved in 6.3 min. The model ran `npm run build` in its own shell four times, all green, with 0 `spawn EPERM` and 0 sandbox denials. The first attempt (`adr087-smoke-luna.enospc`) died on ENOSPC after three green builds: C: filled when a memory spike grew the page file. The P2 driver now stops below 2 GB free rather than scoring the disk as the model's failure.
3. **ADR-086 P2** re-runs next. → Done 2026-10-04: every one of the model's own builds ran inside the fence (30 of
   34 green, the rest real build errors it then fixed; 0 `spawn EPERM`).

**Final review (2026-10-06).** An independent review of the product code found the cross-project exposure above
→ decision 4: `unlabelLowIntegrity` (an empty label set, propagated), `holdWorkspaceLabel` / `releaseWorkspaceLabel`
(counted per workspace, held by `HostSandbox` from its first fenced workspace-write command to `dispose`), and
`sweepWorkspaceLabels` at server startup. Live tests: unlabeling revokes even the child's own files; with project A
closed, project B's fenced command cannot write it, while a second open session on A keeps it writable; the sweep
clears a crash's leftovers. The 14 bench workdirs labeled before this change were swept (10 s). The review also
moved the fence probe back to ONE runner spawn (workspace-write, the default mode) — two in a row doubled the
caller's block.

## References

ADR-070 (the rung, its `partial` boundaries), ADR-081 (HostSandbox is the default runtime), ADR-086 (P2).
Evidence: `eval/runs/p2-qwen-react.stopped-0929/traces/builder-shop-a1.jsonl`, `eval/.work/fence-proto/`
(gitignored).
