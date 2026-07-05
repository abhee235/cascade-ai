# Forensic report — shop-iterate-1 (six-round e-commerce build, 16k pinned window)

**Run:** `builder-shop-iterate` on qwen36-agentic, window pinned to 16,384 (forcing repeated context
fills per the requirement), 60-min budget, full trace + live Phoenix stream, workdir kept.
**Outcome:** timed out mid-round 5 of 6. Rounds 1–3 genuinely built (shop, wishlist, search+filter);
round 4 lost to a backend hang; round 5 spent on heroic disaster recovery. Final check: fail
(missing theme/orders + gutted scaffold).
**Trace:** `eval/runs/shop-iterate-1/` · salvaged workdir: `eval/.work/shop-iterate-1-workdir`.

## Per-round picture

| round | ask | time | turns | story |
|---|---|---|---|---|
| 1 | build the shop | 3.2m | 6 | clean: 4 reads → one 14k write → unprompted `npm run build` ✅ |
| 2 | wishlist | 20.5m | 19 | the grind begins: App.tsx (310 lines) now exceeds the read cap → windowed reads, 2 MultiEdit misses, 10 compactions |
| 3 | search + filters | 19.2m | 26 | same grind + first ENOENT (scaffold already being swept); feature landed anyway |
| 4 | theme toggle | 5.9m | 1 | **lost**: one read, then the model call hung 5 minutes → `fetch failed (Headers Timeout)` → round silently over, zero work |
| 5 | three fixes | 11.3m | 21 | model discovers the gutted workspace, `ls`-investigates, **rebuilds package.json/vite.config/tsconfig/index.html/main.tsx from memory** |
| 6 | orders | — | — | never reached (timeout) |

Totals: 74 model turns · 65 tools (12 errors, all recovered) · **31 compactions** (11 summarize
side-queries) · 2 verify gates · 12 TodoWrite calls · 0 silent truncation deaths.

## What held up under fire (the week's fixes, live)

- **No context death.** 31 compactions at a 16k window and not one 8191/8192-style silent truncation —
  the enforcement + overhead-calibration + read-bites stack works.
- **The task list is real**: TodoWrite used every round to track sub-steps.
- **Recovery behavior is outstanding**: every tool error self-corrected; the destroyed-scaffold
  investigation (ls → diagnose → rebuild) is frontier-grade behavior from a local model.
- The read-cap teaching error was OBEYED (windowed re-reads with the suggested offsets).

## Gaps, ranked (the commissioned deliverable)

1. **[ENV — fixed now] Windows swept the live workspace.** Disk at 96% → Storage Sense cleaned %TEMP%
   mid-run: every file merely COPIED from the template vanished (package.json, configs, index.css,
   node_modules junction); everything the session WROTE survived. Fix shipped: bench workdirs moved to
   repo-local `eval/.work/` (gitignored); 618 stale temp dirs purged.
2. **[PRODUCT — top fix] A 5-minute Ollama hang silently killed a whole feature round.** One
   headers-timeout ended round 4 with zero retry and zero work. The eval runner got crash-recycling
   last week; **core sessions still lack it**. Port the watchdog into the session/resilience layer:
   detect hang/crash signatures → recycle the model → resume the turn.
3. **[HARNESS] The monolith trap.** The model grew ONE App.tsx (365 lines, 17k chars) past the read
   cap by round 2; every later edit fought partial views (8 cap refusals, 3 old_string misses,
   ~15 minutes of grind). Fix shipped: BUILDER_BEHAVIOR architecture rule (small components, ~150-line
   files). Follow-up candidate: edit-anchoring for windowed reads.
4. **[HARNESS] Delegation never triggered** despite massive read pressure — REFUSED reads add zero
   tokens to the ADR-050 pressure counter (interaction with ADR-052 caps). Candidate: count refusals
   toward pressure, or nudge after N refusals of the same file.
5. **[COST] 11 LLM summarize side-queries** dominated non-generation wall time. Candidate: cap the
   summarizer's own output (`maxOutputTokens ≈ 2× expected summary`), consider a cheaper sidecar model.

## Replay

Any turn is restorable: `npx tsx scripts/eval/replay.mts eval/runs/shop-iterate-1/traces/builder-shop-iterate.jsonl
--cwd eval/.work/shop-iterate-1-workdir --turn <N> --prompt "…"` (conversation from the trace, files
from the salvaged workdir).
