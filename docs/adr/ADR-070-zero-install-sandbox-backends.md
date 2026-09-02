# ADR-070 — Zero-install sandbox backends: per-OS isolation without Docker

Extends **ADR-021** (project-root confinement), **ADR-024** (the core `Sandbox` seam + Docker backend),
**ADR-009/035** (permissions). The core seam is unchanged in spirit but grows a policy vocabulary; this
ADR replaces "Docker, else host-exec" with **bundled, per-OS isolation backends** so the Electron app
isolates by default with zero user setup. Docker is demoted to an opt-in power-user backend.

## Context

ADR-024 gave us the right architecture (core defines `Sandbox.exec()`, the wrapper owns the mechanism)
but the wrong default mechanism for the product we're building. The North-Star product is production-grade and
non-technical: they download the Cascade app and build apps. Today that user gets one of two bad outcomes:

- **Host mode** (no Docker): agent commands run with the user's own Node, npm cache, global packages and
  PATH. Cascade projects clash with whatever is (or isn't) installed, and worse, the agent can *change*
  the user's system state. Works on our machine, breaks on theirs.
- **Docker mode**: real isolation, but Docker Desktop is a heavy install with a background daemon and
  licensing prompts. Telling a non-technical user "first install Docker" is a non-starter.

Two additional constraints sharpen the problem:

1. **Any language, not just Node.** The agent must install/run/build Python backends, Rust, Go — arbitrary
   toolchains. This rules out JS-only sandboxes (WebContainers) as the general answer and rules out
   "bundle a private Node" as sufficient environment isolation.
2. **Per-OS bundling is acceptable.** Electron builds are per-platform anyway; each build may carry its own
   OS-native mechanism. We do not need one cross-platform library — the abstraction lives in Cascade
   (the ADR-024 seam), not in a magic dependency.

Prior art we own: **hermetic** (`C:\Projects\hermetic`) — a hand-built Hyper-V Ubuntu VM with an internal
switch + NAT, Docker-in-VM with `userns-remap`/`cap-drop=ALL`. It validates the VM boundary on Windows
end-to-end. Its setup path (admin, reboot, ISO install, netplan) is developer-grade; this ADR is
essentially "hermetic, productized" for the Windows leg.

## What we demand vs. what exists today

### The demand

| # | Requirement |
|---|-------------|
| D1 | Agent can **install toolchains + dependencies, run, and build in any language** inside the sandbox |
| D2 | **Host stays clean**: no writes outside the project/sandbox; no clash with user's toolchains |
| D3 | **Blast-radius containment**: a wrong/malicious agent command cannot read host secrets or damage the host |
| D4 | **Zero manual install**: mechanism is bundled at build time or already present in the OS |
| D5 | **Silent first-run setup** (seconds, no admin prompt if avoidable, no reboot) |
| D6 | Per-project isolation; disposable/rebuildable environments |
| D7 | **Graceful degradation** when the mechanism is unavailable, with visible warning |

### What is available right now (surveyed 2026-08)

**Process-level (no VM) — the "normal way", where the OS offers it:**

| Mechanism | OS | Verdict against the demand |
|---|---|---|
| `bwrap` (bubblewrap, user namespaces) | Linux | ✅ D1–D7. Tiny static binary, bundleable, unprivileged. The normal way on Linux. Landlock (kernel LSM) is the probe-ordered fallback where user namespaces are disabled. |
| Seatbelt (`sandbox-exec`) | macOS | ✅ D1, D3–D7; D2 only if toolchains install to a Cascade-owned prefix (Seatbelt confines execution but does not virtualize the FS). Built into the OS, bundle nothing. |
| An open-source sandbox runtime package | Linux+macOS | ✅ Open-source npm package wrapping both of the above (profiles, network proxy via socat, violation reporting). Used in production by a major terminal coding agent. **No Windows support.** |
| **Restricted token, `WRITE_RESTRICTED`** | Windows | ⚠️ **Viable as a write-fence** (revised verdict — see design below). Unprivileged, zero-install, arbitrary tools survive. Confines **writes only**: reads, network, and process visibility stay open, plus documented Everyone/hard-link boundaries — so it is *partial* enforcement, a fallback rung, not the primary. |
| AppContainer | Windows | ❌ Cannot do arbitrary-path *reads* at all — real tools break immediately. Coarse all-or-nothing network capability. |
| Sandboxie-Plus | Windows | ❌ Closest to "bwrap for Windows" (CoW FS/registry virtualization) but requires a **kernel driver**: admin install, AV flags, fragile across Windows updates. Not silently bundleable. |
| Windows Sandbox (`.wsb`) | Windows | ❌ Despite the name it *is* a Hyper-V VM: Pro-only, ephemeral, one instance, slow start. |

The Windows column's structural truth stands: Windows security is ACL/token-based and has **no
unprivileged "different filesystem view" primitive** — but the restricted-token mechanism (the public
`windows-acl-restrict-poc` pattern, productized below) gives an honest *write-only* fence with zero
install, which is far better than nothing when the VM route is unavailable.

**VM-level — the strongest boundary, and the Windows primary:**

| Mechanism | OS | Verdict |
|---|---|---|
| **WSL2 imported distro** | Windows | ✅ D1–D7. Same Hyper-V hypervisor boundary hermetic validated, but Microsoft ships the kernel/distro plumbing: `wsl --import <rootfs.tar>` is silent, no admin, no ISO, works on Home + Pro. The primary Windows backend. |
| Hyper-V full VM (hermetic) | Windows | ❌ D4/D5: admin, reboot, ISO install, Pro-only. Validated boundary; kept as an optional power-user "hermetic mode". |
| Firecracker / Cloud Hypervisor | Linux-KVM only | ❌ No Windows/macOS build exists; needs `/dev/kvm` + root-ish setup. Datacenter tool. Right answer only for a future hosted execution farm. |
| libkrun / Virtualization.framework | Linux, macOS | ⚠️ Viable macOS upgrade path if Seatbelt's FS seam bites (e.g. brew-only deps). Bigger build item; not v1. |
| QEMU bundled | all | ❌ ~100 MB, seconds-long cold starts, large ops surface. Last resort only. |

**Not general enough / different layer:**

| Mechanism | Verdict |
|---|---|
| WebContainers / Nodebox | ❌ D1: JS/WASM only — no Python/Rust/Go. Also commercial license. At most a future fast-path for pure web projects; scoped out of this ADR. |
| Toolchain managers (mise, Volta, proto) | Not isolation — but solves D2's *clash* half perfectly, any language, cross-platform. Adopted below as Layer 1. |
| Docker | ✅ isolation, ❌ D4/D5. Stays as opt-in backend (ADR-024 implementation unchanged). |

## Decision

Three parts: a **policy vocabulary** in the core seam, a **toolchain layer**, and **per-OS backends**.
Core stays app-agnostic (ADR-024's rule): it learns the *shape* of policy and confinement, never the
mechanisms.

### Part A — Sandbox policy vocabulary (core seam)

The seam grows from a bare `exec()` to a policy-aware contract:

- **Three file-effect modes**, a strict ladder: `read-only` → `workspace-write` → `danger-full-access`.
  The builder's default is `workspace-write`; `read-only` is the plan-mode/fallback floor;
  `danger-full-access` is explicit opt-in per call or session.
- **`SandboxPolicy`** `{ mode, workspaceRoot, sessionId? }` resolved per call: explicit approved
  override ≻ session override event ≻ deployment default. The workspace root is canonicalized with the
  *native* realpath (symlink- and case-converged) before any enforcement compares paths.
- **`writableRoots(policy)`** — one shared derivation of what `workspace-write` *means* (workspace root +
  platform temp dirs), consumed by every enforcing layer (shell backend AND the in-process file-tool
  fence), so "Edit can write /tmp but Bash can't" asymmetries cannot arise.
- **Confinement result** is structured: `confine(argv, policy)` returns
  `{ argv, enforcement: 'full'|'partial', denialSignatures, runnerFailureRules }`.
  - `denialSignatures`: per-backend stderr substrings that mean "the kernel denied a file effect" —
    the tool layer classifies output with them.
  - `runnerFailureRules`: exit-code + stderr signature contracts that mean "the runner itself failed,
    the command never ran" — never misreported as a denial.
- **Escalation choreography** (the weak-model recovery affordance): when a confined call is denied, the
  tool result carries two verbatim markers —
  `[sandbox: file access denied under <mode> mode]` and
  `[sandbox: escalation available — retry this exact command once with sandbox_permissions (the
  narrowest wider mode that suffices) + justification; the approval prompt asks the user]`.
  The tool schema exposes `sandbox_permissions` + `justification` (paired, both-or-neither); execution
  checks strict widening against the call's *effective* mode; the human approves; the grant applies to
  **exactly that one call**. Fail-closed at every missing piece. The hint rides the denial itself, so the
  sanctioned retry does not depend on the model recalling tool docs — exactly the in-context recovery
  pattern our 9B evals demand.
- **Policy in the system prompt**: one short, stable line renders the session's current mode and
  workspace root (cache-safely, per-request section), so the model knows the standing policy without
  tool-description bloat.

### Part B — Toolchain provisioning (all modes, including unsandboxed fallback)

Bundle **`mise`** (single ~10 MB static MIT-licensed binary) in every build. All toolchains (Node, Python,
Go, Rust, …) install per-project into a Cascade-owned prefix (`<appData>/Cascade/toolchains`), never the
user's system. Projects declare toolchains in `mise.toml` → environments are reproducible across machines.
This alone kills the clash/pollution pain (D2) even when no security sandbox is available.

### Part C — Per-OS backend chain (selected at runtime, bundled at build time)

A backend registry in the server wrapper; each backend implements the seam plus `available()` /
`prepare()` (first-run setup) and `confine(argv, policy)`. **Selection is by platform chain, probed
functionally in order, fail-closed** (a platform with no usable rung refuses to run confined commands
rather than silently running them on the host — the visible `none` fallback is a deliberate, surfaced
downgrade, never an implicit one):

| Platform | Chain | Bundled artifacts | First run |
|---|---|---|---|
| Windows | `wsl` → `win-write-fence` → `none` | rootfs tarball (~60–100 MB, mise preinstalled); FFI runner for the fence | `wsl --import cascade-sandbox … --version 2` (silent, seconds); fence needs nothing |
| macOS | `seatbelt` → `none` | nothing (OS built-in) | none |
| Linux | `bwrap` → `landlock` → `none` | `bwrap` + `socat` static binaries (~2 MB) | none |
| any | `docker` (ADR-024, unchanged) | — | opt-in, power users |

`none` = Layer B env isolation + input-aware permissions (ADR-035) + visible warning.

**The Windows write-fence rung (`win-write-fence`)** — the new design, an unprivileged userspace runner
built on OS token semantics (prior art: the public `windows-acl-restrict-poc` pattern):

1. Duplicate the caller's token via `CreateRestrictedToken` with **`WRITE_RESTRICTED`** (+ `LUA_TOKEN`,
   `DISABLE_MAX_PRIVILEGE`): Windows then checks every *write* twice — the object's normal DACL **and**
   the token's restricting-SID list. Reads are untouched, which is precisely why arbitrary toolchains
   (npm, pip, cargo, pwsh) keep working where broker-style restricted tokens kill them.
2. Restricting list per mode: `read-only` = [logon SID, Everyone] (the keep-alive pair — DLL init and
   CNG die without them); `workspace-write` adds a **workspace SID** and a **per-session temp SID**.
3. **Deterministic workspace identity**: the workspace SID is derived from the canonical workspace path
   (`S-1-4-<two 30-bit values from sha256(path)>`). Granting it an inheritable write ACE on the workspace
   root is an eager full-tree propagation (slow once on big trees) — but the same workspace always derives
   the same SID, so the ACE **stands** across sessions and restarts and every later provision hits an
   exact-ACE skip (O(1)). A standing ACE is *inert* under `read-only` (the restricting list simply doesn't
   carry the SID), which makes mode downgrades free and re-upgrades instant.
4. **Per-session private temp**: each live session/workspace pair gets a random temp directory with its
   *own* derived SID (revoked + removed on dispose); TMP/TEMP are rewritten for the child. Sessions on the
   same workspace share workspace authority but can never write each other's temp.
5. **Runner contract mirrors bwrap**: same argv-prefix wrapper shape
   (`runner --workspace <dir> --temp <dir> --mode <m> [--write-sid … --temp-write-sid …] -- <argv…>`),
   child wrapped in a `KILL_ON_JOB_CLOSE` job, exit code mirrored, every Win32 call checked and
   **fail-closed** (any failure → never spawn unrestricted), runner failures print a distinct stderr
   signature + exit 127 so they are never classified as denials.
6. **Honest `partial` report**: Everyone-writable external objects stay writable; NTFS hard links alias
   file objects across paths (pnpm's store makes banning them non-viable); reads/network/process
   visibility are unrestricted; piped-stdio capture inside the fence fails for grandchildren. The rung
   *always* reports `enforcement: 'partial'`; the UI and the model-facing docs state the boundary. This is
   why it is the **fallback** rung — the WSL VM stays primary because D3 includes reads and network.

### Working defaults (overridable, recorded so implementation is unblocked)

1. **Windows project location — DECIDED at step 5 (supersedes the original "inside the distro FS"
   default): the project stays on the HOST, drvfs-mounted into the distro per-project.** Building it
   showed inside-placement breaks every host-path consumer at once (ProjectManager scaffolding, the
   file tools, git checkpoints — all operate on real Windows paths), while the mount pattern is
   Docker's proven bind-mount shape reused verbatim: the project dir is the ONLY host path reachable
   from inside (automount off ⇒ the mount IS `workspace-write` made physical), `node_modules` is
   shadowed by a distro-native dir (the measured 9p-speed lesson), and in-VM writes land where the
   host tools already look. Two consequences carried forward: Vite needs `CHOKIDAR_USEPOLLING`
   (inotify does not cross drvfs), and dev logs ride the mount so the host log-follower works as-is.
2. **Network policy v1: outbound-open with a deny-list** (hermetic's accepted risk; least friction);
   allowlist-only ships later as a hardening flag.
3. **Hosted web-app sandbox: separate future ADR** (server-side mechanisms; different problem).

## Implementation plan (one rung at a time, each independently shippable)

| Step | Scope | Done when | Status |
|---|---|---|---|
| 1. Policy vocabulary in core | `SandboxPolicy` (3 modes), `writableRoots`, canonical-path rule, structured `confine()` result, policy line in system prompt; `DockerSandbox` adapted to the new shape | Unit: mode resolution ladder, roots derivation, policy-section render. Existing Docker tests still green | ✅ Done (`core/sandbox/policy.ts`, `sandboxPolicy.test.ts`) |
| 2. Denial classification + escalation | Tool layer: classify confined stderr via `denialSignatures`; denial + hint markers; `sandbox_permissions`/`justification` schema fields; strict-widening check; approval flow; one-call grant | Unit: marker texts pinned; malformed pairings rejected; non-widening asks never prompt. Eval: weak-model denied-write scenario recovers via escalation | ✅ Done (`core/sandbox/escalation.ts`, `sandboxEscalation.test.ts`); eval scenario deferred to next batch |
| 3. Toolchain layer (mise) | Bundle mise; Cascade-owned prefix; per-project `mise.toml`; TMP/prefix env injection in every exec mode | E2E: `install python` lands in the prefix, never in user PATH; project reproducible on second machine | ✅ Done (`server/toolchains.ts`); live E2E green (jq install into the prefix) |
| 4. macOS + Linux backends | Backend registry + platform chains + functional probes (bounded timeouts); Seatbelt profile; bwrap profile; Landlock fallback rung | Gated live tests per OS: write inside workspace ok, outside denied with correct signature; probe failure → next rung; no rung → fail closed | ✅ Done (`server/sandboxBackends.ts`); unit matrix green; bwrap kernel live suite ready (Linux-gated). Landlock rung deferred (needs bundled launcher) |
| 5. Windows WSL backend | Rootfs build script (Alpine/Debian + mise); first-run `wsl --import`; project drvfs-mount; `\\wsl$` affordance; dispose/rebuild | E2E on fresh distro: scaffold + build a Node and a Python project; host FS diff outside project dir is empty | ✅ Done (`server/wslSandbox.ts`, `scripts/build-wsl-rootfs.ps1`); full live E2E green on Windows |
| 6. Windows write-fence rung | FFI runner (restricted token, deterministic workspace SID, private temp, fail-closed), probe, `partial` report, standing-ACE reuse cache | Live suite: outside-workspace write denied; runner failure ≠ denial; Everyone/hard-link boundaries pinned as known-partial | ✅ Done (`server/winFence.ts` + `winFenceRunner.ts` + `winFenceSid.ts`); live kernel suite green on Windows, no admin |
| 7. Selection UX | Chain status surface (which rung is active, why), degradation warnings; honest host-mode confinement label | Manual: pull each rung out (uninstall/disable) and watch the chain degrade visibly, never silently | ✅ Done (`RuntimeInfo.wslAvailable`/`hostConfinement`, `SettingsPage`); Host/WSL/Docker selector + partial-fence note |

Order rationale: steps 1–2 are pure core/tool work that pays off immediately (even Docker users get the
escalation ladder); step 3 kills D2 everywhere; steps 4–6 land backends cheapest-first; step 7 makes
degradation honest. Each step ends in a tagged checkpoint per the phase discipline.

**Deferred (tracked, not blocking):** the Linux Landlock fallback rung (needs a bundled launcher binary);
the weak-model escalation-recovery eval scenario (next eval batch); the `hermetic mode` external-VM escape
hatch (power-user tier — the WSL rung already delivers the VM boundary for the common case).

## Consequences

- **Non-technical users get isolation by default** — nothing to install on any OS; the strongest boundary
  (VM) lands on the platform with the most users; Windows without WSL2 still gets a real write fence
  instead of nothing.
- **Core stays pure** (ADR-024 holds): policy and result shapes are generic; mechanisms live wrapper-side.
  The VS Code extension keeps host-exec (policy `danger-full-access`, `none` backend) unchanged.
- **The escalation ladder becomes a product feature**, not sandbox plumbing: denials turn into a guided,
  human-approved, one-call widening — measurable in the weak-model evals.
- **Windows carries the bulk**: installer grows ~60–100 MB (rootfs); the write-fence adds an FFI runner
  whose ABI must be pinned by a native verification probe (struct sizes asserted at module load — layout
  drift fails loudly, never corrupts memory).
- **Write-fence residue is by design**: standing workspace ACEs persist (the reuse cache; inert under
  read-only, invisible to users); temp ACEs/dirs are revoked on dispose and crash residue is inert
  (fresh random path + SID every provider). A future cleanup command may reap renamed-workspace ACEs.
- **macOS has a known seam**: Seatbelt + mise-prefix covers unprivileged toolchains; brew-only native deps
  pierce it. Upgrade path recorded: libkrun microVM.
- **Docker demotion is not removal**: existing `DockerSandbox` and its tests stay; it becomes one registry
  entry.
- **Firecracker explicitly rejected for local** (Linux-KVM-only, root-ish setup) but noted as the correct
  tool the day Cascade runs a hosted execution farm.

## Verification

- Unit (no OS deps): selection matrix (platform × probe verdicts × override), policy ladder, roots
  derivation, marker/signature texts, escalation pairing + strict-widening rules.
- Integration (gated per OS, like `CASCADE_DOCKER=1`): per-rung live denial/allow tests; probe-failure
  degradation; runner-failure vs denial classification; mise prefix containment.
- Windows E2E: fresh `wsl --import` → agent scaffolds + builds Python and Node projects → host diff clean;
  fence rung: cross-session temp isolation + known-partial boundaries pinned as regression tests.
- Eval harness: denied-write → escalation → approved-retry scenario added to the weak-model suite.

## Prior art

**Terminal coding agents** commonly wrap every Bash command with an open-source sandbox runtime (bwrap on
Linux, Seatbelt on macOS) driven by permission settings; on native Windows they typically have **no sandbox at
all** and rely on permission prompts — exactly the gap this ADR closes for Cascade, first with the WSL VM rung
and then with the write-fence fallback those agents lack.
**hermetic** (ours) proved the Windows VM boundary by hand: Hyper-V + internal switch/NAT + hardened
Docker-in-VM. The `wsl` backend is that same hypervisor boundary with Microsoft operating the VM
plumbing — hermetic productized; full hermetic remains the optional paranoid tier.
