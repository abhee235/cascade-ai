# ADR-082 — Everything in the box: file tools through the sandbox seam, and grounded escalation

Extends **ADR-070** (zero-install sandbox backends) and **ADR-024** (the `Sandbox` seam). Status: proposed
2026-09-13. Part A is implemented in this branch (a small amendment to ADR-070 step 2); Part B is the design
for the next arc.

## Context

ADR-070 shipped and was validated end to end on 2026-09-13 (kernel-level write-fence, the WSL VM rung, the
packaged Electron path). Two things surfaced in the first live run that this ADR answers.

**1. The isolation the product promises vs. the isolation the seam gives.** The user's mental model — the
right one for a production-grade product — is *"the app lives in the box; nothing comes out except the project
folder."* Today that is true for **commands** (Docker/WSL run them inside; the project folder is the only
host path bridged; the live suite proved `/mnt/c` is unreachable) but not for **file tools**: Read/Write/Edit
execute in the server process on the host, confined by the path jail (ADR-033) — a check in trusted code
over a model-controlled path, i.e. a *policy fence, not a kernel boundary*. A jail bug is a host write; a
VM boundary bug is not. A survey of an open-source agent harness shows the same split in its default local
design, with the same honest self-description (its own docs call its fs fence a policy fence rather than a
kernel boundary — containment, not a security boundary) — and shows the fix: its remote cloud-VM mode
relocates the *filesystem seam* into the sandbox, so file tools execute inside against the real remote FS with
no host jail at all. Cascade already has the local box; it lacks the relocated fs seam.

**2. Escalation was reachable without a denial — and a hard error manufactured one.** Measured with
gpt-5.6-luna in the plan stage: the model set `sandbox_permissions: "workspace-write"` (the mode it already
held) on its *first* `Write PLAN.md`. The scheduler bounced the non-widening ask as an error and **discarded
the call**; PLAN.md was never written; the model read a missing file, concluded it needed *more*, and re-sent
the identical Write with `danger-full-access` — a valid widening — parking the session on an approval prompt
that a reflexive click would have turned into a full sandbox bypass. ADR-070's guard against pre-emptive
escalation was description text ("ONLY after a denial"). ADR-049's lesson holds for frontier models too:
text alone does not enforce.

## Decision — Part A (implemented): grounded, no-op escalation

The escalation judge (`core/sandbox/escalation.ts`) has four outcomes instead of three:

| ask | before | now |
|---|---|---|
| malformed pairing (mode without justification, blank justification…) | error, call bounced | **unchanged** — a model error |
| mode the call already holds, or narrower | error, call bounced | **no-op**: fields stripped, call runs under the current policy, note appended |
| no confined policy active | error, call bounced | **no-op** (the call runs unrestricted anyway) |
| strictly wider, **no denial yet this session** | prompt the user | **no-op** with a note that names the rule |
| strictly wider, **after a real denial** | prompt the user | **unchanged** — the one case that reaches a human |

The scheduler records `ctx.sandboxDenialSeen = true` when any tool result carries the denial marker prefix
(`[sandbox: file access denied`), on the session's shared ctx so it persists across steps; a per-call widened
copy never receives it. The judge's note rides the tool result (`[sandbox: sandbox_permissions ignored — …]`)
so the model learns the rule at the decision point. The field descriptions now say the same thing in one
extra clause. Invariants preserved: a non-widening ask never reaches a human; the model never reads its own
escalation fields (still stripped); no approval channel ⇒ no widening. Invariant added: **an escalation
prompt is only ever grounded in a denial the model actually received.**

Why a no-op and not a softer error: failing the call is the mechanism that manufactured the escalation.
Running the call under the current policy is always safe (that policy is already in force) and costs the
model nothing it did not already have.

**The second half, measured after shipping the first.** The no-op made the run *safe*, and the next live
build (gpt-5.6-luna, 2026-09-15, 6 submits) proved it: 35 escalation asks, **0 approval prompts, 0 discarded
calls**, and the `Write PLAN.md` that broke the previous run went through. But it did not make the run
*quiet* — **35 of 35** Write/Edit/Bash calls carried `sandbox_permissions`, every one a no-op, and the
"ignored" note came back 34 times without ever changing the model's behaviour. An optional field the model
can see is a field it fills; a description explaining when *not* to use it does not hold, on frontier models
any more than on weak ones (ADR-049). So the fields are now also **hidden from the advertised schema until
`sandboxDenialSeen` is true** (`withoutEscalationFields`, applied in the loop's `advertise()`). The schema
changes at most once per session — a single KV-cache break, at the moment the model is already re-reading a
failure — and sessions that never touch the fence never pay for the fields at all. The rule is now enforced
in all three places it can be: the lever is not shown, not honoured, and not promptable until a real denial.

## Also fixed in this arc: capability by method, not by enum

The same live run surfaced an unrelated regression worth recording here, because Part B will add per-runtime
backends and must not repeat it. `browserHostFor` read `if (runtime.kind !== 'host') return undefined` —
correct when ADR-081 §4 defined the runtime vocabulary as `host | docker`. ADR-070 added a third value,
`wsl`, and audited command *execution* while nothing audited tool *composition*. The result: **every WSL
session shipped with no Browser tool at all.** The agent loaded the browser skill, spawned the smoketester
subagent twice, got "Browser tool is unavailable" both times, tried `curl` (absent, exit 127) and a
`npm run dev` the preview guard correctly refused, and reported "not verified" — while that blind subagent
confidently reported a checkout bug that did not exist (verified by hand: the confirmation renders
correctly). Blind verification does not merely fail to find real defects; it manufactures false ones that
the next turn will "fix".

`WslSandbox implements ProjectRuntime` and always had the four methods the adapter needs, so the fix is to
delete the check: a capability is derived from what a runtime **can do**, never from an enum a later ADR can
extend. The test is now parameterised over several `kind` values, including one that does not exist yet, so
a fourth runtime cannot reintroduce the bug by simply not being thought of. **Rule for Part B:** `fs-wsl` /
`fs-docker` must be selected by probing for the capability, not by switching on `runtime.kind`.

### Three more, all found by RUNNING it (amendments to ADR-070 steps 5–6)

Each was invisible to the unit suite and to a prior full build; each was found only by driving the real
server and reading what the box actually did.

1. **The package cache must be writable, or nothing installs.** A build's first act is `npm install`, and
   npm writes to a cache that lives outside the workspace in BOTH confined runtimes — `/root/.npm/_cacache`
   under bwrap (`EROFS`) and `%LOCALAPPDATA%\npm-cache` under the Windows fence (`EPERM`). Both now redirect
   into an already-granted location: a per-project VM-local `HOME` (`/var/cascade/home/<key>`, bound
   writable only under workspace-write) and the workspace-private temp dir the fence already grants
   (`npm_config_cache`, beside the existing `TMP`/`TEMP` redirect — no new ACE, no widening). The WSL case
   hid for a whole build because `installDependencies()` calls `exec()` with **no policy**, so the server's
   own install is never wrapped — only the model's is. *Generalisation: every default write location a real
   toolchain uses must be enumerated and redirected; confining writes without providing a writable cache
   makes the sandbox look broken rather than strict, and invites a `danger-full-access` escalation to fix a
   provisioning gap.*
2. **`&` binds looser than `&&`.** `mount && cd && setsid npm run dev … & echo $! > dev.pid` backgrounds the
   *entire* chain, so `wsl.exe` returned before it reached vite: every Browser call and every Preview start
   under WSL failed with "the dev server did not answer", leaving a fresh `dev.pid` and **no `dev.log`**.
   Running the same commands by hand worked — an interactive shell outlives the background chain — which is
   exactly what disguised a quoting bug as a preview bug. Fixed by grouping (`{ … ; }`) so only the server
   detaches, and `startDev` now THROWS on a non-zero launch instead of discarding `run()`'s result, which
   had converted every failure into a silent 30-second timeout with no diagnostic anywhere.
3. **Cascade's own metadata was being committed into the user's project history.** `.cascade/` was never
   ignored, so each checkpoint's `git add -A` swept the forensic traces in — one builder trace measured
   **14 MB**, re-committed every turn. The template now ignores it and `checkpoint()` backfills the rule and
   drops anything already tracked from the index (files on disk untouched, so a live build keeps writing).

## Decision — Part B (proposed): the fs seam inside the box

Grow the core `Sandbox` seam (ADR-024) from `exec()` to a **file capability**, and route the in-process file
tools through it whenever the runtime provides one:

```ts
interface SandboxFs {
  stat(path): Promise<{ kind: 'file'|'dir'|'missing'; size; mtimeMs }>
  readText(path): Promise<string>
  writeText(path, text): Promise<void>          // atomic: sibling temp + rename, inside the box
  listDir(path): Promise<Entry[]>
  realpath(path): Promise<string>               // canonical identity as the BOX sees it
}
interface Sandbox { exec(...); fs?: SandboxFs; ... }
```

- **Docker runtime** — `fs-docker`: operations run via `docker exec` in the project container against the
  bind mount; a small persistent helper process inside the container (started with the container, JSON
  lines over stdio) avoids a spawn per operation.
- **WSL runtime** — `fs-wsl`: the same helper inside `cascade-sandbox`, reached over `wsl.exe -d … --exec`,
  operating on the drvfs-bridged project dir. Paths the model sees are the in-VM paths it already sees
  (`/projects/<key>/…`), so canonicalization and the jail are evaluated *by the VM's kernel* on the VM's view.
- **Host runtime** (the write-fence tier) — no `fs`; file tools keep the in-process jailed path. Nothing
  changes for the extension or for hosts with no backend.

Tool routing: Read/Write/Edit/MultiEdit/Glob/Grep call `ctx.sandbox.fs` when present, else `node:fs`. The
ADR-032 freshness cache keys on the box's `realpath` + `mtimeMs`; the edit ladder (editCore) is pure over
text and needs no change. The preview, the file tree, git and "open in Explorer" keep reading the host side
of the bridge — the folder remains the deliberate shared surface.

What this buys, per threat: a jail bug can no longer become a host write or a host read in the sandboxed
runtimes (the box cannot see the host); host secrets are unreadable to *every* tool, not only to commands;
the two families are enforced by one boundary, so shell/file asymmetries cannot arise. What it does not buy:
host mode stays `partial` (documented, as ADR-070 states); network stays open (ADR-070 default #2); the
project folder itself is, by design, fully reachable.

Working defaults: helper protocol = newline-delimited JSON over stdio, one helper per runtime instance, lazy
start, restarted on failure; large reads stream in chunks; binary files stat-only (as today).

## Consequences

- The sandboxed runtimes become the "everything in the box" world the product promises, with no change to
  how users see their project. This is the point at which Cascade's local WSL/Docker tiers exceed that
  harness's *default* (host, in-place) and match its opt-in remote world — locally, with nothing to install.
- One more seam to keep coherent across three runtimes; the parity test idea from the skins work (identical
  behavior across backends over a fixture tree) is the natural guard.
- Per-operation latency rises from an in-process call to a helper round-trip (~1–5 ms in-VM); batching in
  the tools that fan out (Glob/Grep) keeps the builder's turn times flat.

## Verification

- Part A: `sandboxEscalation.test.ts` pins the four outcomes, the luna sequence (a same-mode ask on Write
  *runs* the write), the unsolicited-wider no-op, and the grounded prompt path; the live rerun of the
  Northline round 1 must complete the plan stage without a prompt.
- Part B: a fixture tree exercised identically through `node:fs`, `fs-docker` and `fs-wsl` (parity);
  live suites per runtime proving a jail-bypass attempt (`../../` beyond the root, a symlink out) is refused
  *by the box*, not by our check; the freshness guard holding across an in-box write.

## Prior art

The surveyed open-source harness: local default = in-place kernel confinement of commands + a userland fs
fence, reads never restricted, explicitly not a general-purpose security sandbox; remote (opt-in) = fs and
shell seams relocated into a cloud VM, file tools inside, no host jail, no sync back, state on the host.
Terminal agents also commonly offer a devcontainer — the whole CLI runs in the container by the user's choice.
Another CLI agent defines the three sandbox modes this vocabulary comes from. Part B gives Cascade the
cloud-VM-shaped fs seam over its own local boxes.
