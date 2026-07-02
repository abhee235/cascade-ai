# Learning: the 5-layer compactor, walked through one real session

Conceptual companion to **ADR-039**. The ADR says *what* we built; this note shows the algorithm running on a
concrete conversation, so the escalation and early-stop are obvious. Written to be readable by someone new to
agent harnesses.

## Q: Why compact at all?

The model is **stateless** — every turn resends the *entire* history (system prompt + all messages + every tool
call and result). That blob must fit the **context window** (tokens ≈ chars ÷ 4). A coding session fills it fast
(one big `Read` or noisy `npm test` = thousands of tokens). Near the limit you must **shrink history without
losing what the model still needs**. That's compaction — and it's *five layers*, not one delete, precisely so it
loses as little as possible.

## The four concepts

1. **The plan** (from the model profile, ADR-038): thresholds deciding *when*. Real 32k Qwen →
   `auto ≈ 22,937` (compact trigger), `keepRecent ≈ 6,144` (newest tokens kept verbatim), `maskOver ≈ 1,310`
   chars. *For this walkthrough we shrink them:* `auto=350`, `keepRecent=300`, `maskOver=400`, `snipOver=400`.
2. **Older / recent split**: walk back from the newest message until `keepRecent` tokens are collected — that
   newest slice is **recent** (frozen, never compacted); everything before is **older** (fair game).
3. **The layers**: five transforms, cheapest + least-lossy first; re-check after each; **stop the instant we
   fit**.
4. **What each targets** (the whole design in one table):

| Layer | Targets | Loses |
|---|---|---|
| collapse | superseded read/search **outputs** | nothing real (a stale duplicate) |
| mask | *oversized* old **outputs** | big blobs only |
| microcompact | *all* remaining compactable **outputs** | all old observations |
| snip | large tool **inputs** (Write/Edit bodies) | the body (keeps a 1-line record) |
| summarize | the whole older half | detail (LLM writes a summary) |

Layers 1–3 clear **outputs**, layer 4 clears **inputs**, layer 5 is the LLM last resort. Non-overlapping on
purpose.

## The example session (build a dark-mode toggle) — 15 messages

```
idx  role       what                                             T
──────────────────────────── OLDER (compactable) ────────────────────────────
 0   user       "Add dark-mode toggle; track tasks; run tests"   22
 1   assistant  tool_use TodoWrite                               20
 2   user       result → "Todos: [ ]find [ ]add [ ]test"         25   PROTECTED (TodoWrite)
 3   assistant  "Searching." + Grep("theme")                     25
 4   user       result → grep output (800 chars)                200   big output
 5   assistant  Read theme.ts   (r1)                             10
 6   user       result r1 → theme.ts (480 chars)                120   SUPERSEDED later
 7   assistant  "Adding toggle." + Write(settings.tsx)           360   1400-char body (INPUT!)
 8   user       result w1 → "File created."                       5
 9   assistant  Read theme.ts AGAIN (r2)                          10
10   user       result r2 → theme.ts (480 chars)                120   latest read
──────────────────────────── RECENT (verbatim) ──────────────────────────────
11   assistant  "Running tests." + Bash("npm test")              15
12   user       result → test output (900 chars)                225
13   assistant  "2 tests failed — fixing the import."            15
14   user       "go ahead"                                        4
                                                     TOTAL ≈  1,176
```

## The algorithm runs

**Step 0 — trigger:** `1,176 ≥ auto 350` → compact. (Under `auto` ⇒ return untouched.)

**Step 1 — split:** walk back `14(4)→13(15)→12(225)→11(15)=259`; adding `10` would exceed 300 → **boundary 11**.
`OLDER = 0–10 (≈917 T)`, `RECENT = 11–14 (≈259 T, frozen)`. The frozen slice is the test output + "2 tests
failed" + "go ahead" — exactly what the model needs now.

**Layer 1 collapse:** theme.ts read twice (r1 idx6, r2 idx10); r1 is the stale duplicate → clear idx6 to a
`[Superseded…]` marker. **−90 T → 1,086.** Still ≥350 → continue. *(If auto≥800 we'd still be over.)*

**Layer 2 mask:** clear older outputs > 400 chars: idx4 grep (−187), idx10 r2 (−107). idx2 todo (100 chars)
untouched; idx6 already cleared. **−294 → 792.** *(If `auto`≥800 → 792<800 → **STOP**, kind="masked", no LLM.)*

**Layer 3 microcompact:** clear all remaining *compactable* outputs → only idx8 `"File created."` (5 T) left;
replacing 5 T with a ~12 T marker would GROW tokens, so the "only adopt if it shrinks" guard **rejects it →
no-op.** (Two lessons: microcompact pays off when many mid-size stale outputs remain; and the guard prevents a
layer ever backfiring. idx2 TodoWrite is never eligible — not a compactable tool.)

**Layer 4 snip:** idx7 `Write` still carries the 1,400-char file **input** (360 T). Replace the body with a stub
`{_compacted:true, note:"Write settings.tsx — input elided (1400 chars)"}` (~20 T) — the model still sees *it
wrote the file*. **−335 → 457.** *(If `auto`≥550 → 457<550 → **STOP**, kind="snipped".)* This is the step beyond
cheap layers that only clear outputs.

**Layer 5 summarize:** cheap layers exhausted, still 457≥350 → now pay for the LLM. Summarize the OLDER half
(mostly markers/stubs + the request + protected todo) into one ~90 T message; keep RECENT verbatim.
`[15 msgs, 1,176 T] → [summary(90), 11,12,13,14] ≈ 349 T < 350 → done, kind="summarized".`

## The run at a glance
```
start                     1,176  ██████████████████████  (auto=350)
collapse  −90 dup read    1,086  ████████████████████
mask      −294 big outs     792  ███████████████         ← stop if auto≥800
microcompact  no-op         792  ███████████████
snip      −335 Write body    457  █████████               ← stop if auto≥550
summarize older→1 msg        349  ██████                  ✓ under 350
```
**One history, three possible stop points** depending on window tightness — same code, the plan decides.

## Two rules that keep it safe
1. **RECENT is sacred** — layers only touch OLDER; the model's current work is byte-for-byte intact.
2. **Escalate + stop early** — never summarize (lossy, slow, costs an LLM call) if clearing a stale duplicate
   sufficed. Safety net: on real overflow the loop re-runs with `force:true`, skipping the threshold checks.

## Why it matters for weak/local models
A 32k local model hits this constantly and rots faster as it fills. The stack lets it keep working far longer
(cheap layers buy runtime), never lose its current task (RECENT frozen), reclaim the biggest hog (`snip` on file
writes), and pay for a summary only as a last resort. See [[tool-faculties]] for where compaction sits among the
harness faculties, and ADR-038/039 for the plan + layers.
