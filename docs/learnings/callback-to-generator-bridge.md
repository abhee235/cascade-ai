# Learning: the callback → async-generator bridge (the scheduler's progress pump)

## The problem
A tool reports progress via a **callback** (`onProgress(chunk)`) — push-based, fires whenever. The scheduler
is an **async generator** — it can only `yield` from *its own body*, NEVER from inside a callback. So we
can't `yield` when `onProgress` fires. We need a buffer + a way to wake the generator.

## The one idea: "pause, and leave a resume button"
```js
await new Promise((resolve) => { wake = resolve })
```
= "make a promise, SAVE its resolve into `wake`, then pause here until someone calls that saved function."
`wake` is a **resume button**. `bump()` = "press the button":
```js
const bump = () => { const w = wake; wake = null; w?.() }
```
This is the SAME trick as permission ([[tool-call-binding]] / the `perm.request` handshake): stash a
promise's `resolve`, call it later to un-pause. Here it wakes a loop instead of answering a prompt.

## The analogy (receptionist + bell)
- loop = receptionist sorting mail from a **mailbox** (`queue`)
- tools = workers who drop letters (chunks) in the mailbox
- mailbox empty + workers busy → receptionist **sleeps**, leaving a **bell** (`wake`)
- worker drops a letter and **rings the bell** (`bump`) → receptionist wakes, drains mailbox, sleeps again
- all workers home (`pending===0`) + mailbox empty → lock up (loop ends)

## Trace: Bash running `echo hi` (watch queue / wake / pending)
1. start tool (don't await) — `[]`, null, 1
2. loop: empty mailbox, busy → sleep, set bell — `[]`, 🔔, 1
3. `echo` prints → onProgress: push + bump — `["hi"]`, null, 1
4. loop wakes → drain → **yield toolProgress "hi"** — `[]`, null, 1
5. empty → sleep again — `[]`, 🔔, 1
6. tool finishes → .then: pending--, bump — `[]`, null, 0
7. loop wakes → empty AND pending 0 → **exit**
8. emit toolResult

Step 4 is the whole point: a chunk that arrived in a *callback* (3) became a *yield* (4).

## Why no chunk is ever lost (single-threaded)
JS is single-threaded: between `if (pending===0) break` and `await new Promise(res => wake = res)` there is
no `await`, so no callback can interleave there. A callback only runs while we're parked at the `await`
(asleep, bell set); it pushes + bumps; we wake and drain. A chunk pushed while we're busy just waits for the
next drain. Drain happens at the TOP of the loop, before sleeping — so we never sleep with mail unread.

## The escape hatch (what this complexity buys)
It exists ONLY for *live* streaming. Without it the block collapses to:
```js
const blocks = await Promise.all(toRun.map(tu => executeTool(tu, ctx))) // results only at the end, no progress
```
The queue/wake/bump dance is the price of seeing Bash output as it happens instead of all at once.

## Prior art
The common shape: tools take an `onProgress` and the orchestrator streams tool output as events while
running; one AbortController cancels in-flight tools.
