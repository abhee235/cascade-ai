import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  olderBoundary,
  turnAlignedBoundary,
  maskObservations,
  compactIfNeeded,
  measureWireOverhead,
  planCompaction,
  type CompactionPlan,
} from '../src/context/compactor'
import { createFakeProvider, textDelta } from './fakeProvider'
import type { ContentBlock, Message } from '../src/protocol'

/** Every tool_result in `messages` must have a matching tool_use somewhere before it — otherwise the sequence
 *  is invalid (an orphaned tool result 400s on strict hosted APIs such as OpenAI). Returns the orphaned ids (empty = valid). */
function orphanedToolResults(messages: Message[]): string[] {
  const useIds = new Set<string>()
  const orphans: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'tool_use') useIds.add(b.id)
      else if (b.type === 'tool_result' && !useIds.has(b.tool_use_id)) orphans.push(b.tool_use_id)
    }
  }
  return orphans
}

// A tiny synthetic plan for the compactIfNeeded tests: compact at 80 tok, keep 25 tok recent.
// (Real sizing is covered by compactionPlan.test.ts.)
const plan: CompactionPlan = {
  window: 100,
  effectiveWindow: 100,
  warn: 60,
  auto: 80,
  hard: 97,
  keepRecentTokens: 25,
  keepRecentResults: 5,
  toolResultMaxChars: 2000,
  layers: new Set(['mask', 'summarize']),
  mode: 'layered',
  tier: 'full',
}

describe('compactor — helpers', () => {
  it('estimateTokens ~ chars/4', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(40) }])).toBe(10)
  })

  it('maskObservations masks large tool_results in the OLDER region only', () => {
    const big = 'A'.repeat(5000)
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: big }] }, // older (idx 0)
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: big }] }, // recent (idx 1)
    ]
    const out = maskObservations(msgs, 1) // olderCount = 1
    expect((out[0].content as any)[0].content).toMatch(/output masked/)
    expect((out[1].content as any)[0].content).toBe(big) // recent untouched
  })

  it('olderBoundary splits [older | recent] by the keep-recent budget', () => {
    const msgs: Message[] = Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(40) })) // 10 tok each
    expect(olderBoundary(msgs, 25)).toBe(3) // keeps last 2 (20 tok ≤ 25); a 3rd would overflow
  })

  it('turnAlignedBoundary walks a summarize split back to the nearest assistant (never orphans a tool_result)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q' }, // 0
      { role: 'assistant', content: [{ type: 'tool_use', id: 'A', name: 'Read', input: {} }] }, // 1
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'A', content: 'r' }] }, // 2
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, // 3
    ]
    expect(turnAlignedBoundary(msgs, 2)).toBe(1) // raw split @2 = user(tool_result) → back to the assistant @1
    expect(turnAlignedBoundary(msgs, 3)).toBe(3) // already an assistant → unchanged
    expect(turnAlignedBoundary(msgs, 1)).toBe(1) // already an assistant → unchanged
    // Degenerate all-user history (no assistant, so no tool pairs to orphan) → keep the raw split.
    expect(turnAlignedBoundary([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], 1)).toBe(1)
  })
})

describe('compactor — compactIfNeeded (plan-driven, ADR-039)', () => {
  it('under threshold ⇒ no change', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const provider = createFakeProvider([])
    const { kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan })
    expect(kind).toBe('none')
  })

  it('Layer A: masking large old tool output is enough ⇒ kind "masked", no LLM call', async () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'A'.repeat(4000) }] }, // ~1000 tok, older
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
    ]
    const provider = createFakeProvider([]) // summarize must NOT be called
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan })
    expect(kind).toBe('masked')
    expect((messages[0].content as any)[0].content).toMatch(/output masked/)
    expect(provider.calls.length).toBe(0)
  })

  it('Layer B: summarizes the older half into one message, keeps recent verbatim', async () => {
    const older: Message[] = Array.from({ length: 7 }, (_, i) => ({ role: 'user', content: `old message ${i} ${'x'.repeat(36)}` }))
    const recent: Message[] = [
      { role: 'user', content: `recent ${'y'.repeat(36)}` },
      { role: 'assistant', content: [{ type: 'text', text: `reply ${'z'.repeat(36)}` }] },
      { role: 'user', content: `latest ${'w'.repeat(36)}` },
    ]
    const provider = createFakeProvider([[textDelta('STRUCTURED SUMMARY OF OLDER')]])
    const discarded: Message[][] = []
    const { messages, kind } = await compactIfNeeded([...older, ...recent], {
      provider,
      model: 'fake',
      plan,
      onDiscard: async (o) => void discarded.push(o),
    })
    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('STRUCTURED SUMMARY OF OLDER') // summary replaces older
    expect(messages.length).toBeLessThan(older.length + recent.length) // history shrank
    expect(messages[messages.length - 1].content).toContain('latest') // most-recent message kept verbatim
    expect(discarded[0].length).toBeGreaterThan(0) // coupled-curation hook saw the older messages
  })

  it('summarize never orphans a tool_result: recent starts on an assistant, pairs stay intact', async () => {
    // Boundary would naturally land on a user(tool_result) whose assistant(tool_use) is in the summarized older
    // region — the exact orphan case. After the fix, `recent` must start on the assistant so the pair survives.
    const big = 'x'.repeat(40) // ~10 tok each, so the ~25-tok recent budget lands the raw split on @4
    const msgs: Message[] = [
      { role: 'user', content: `start ${big}` }, // 0 older
      { role: 'assistant', content: [{ type: 'text', text: `reading ${big}` }, { type: 'tool_use', id: 'A', name: 'Read', input: { file_path: 'a.ts' } }] }, // 1
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'A', content: `contents ${big}` }] }, // 2
      { role: 'assistant', content: [{ type: 'text', text: `editing ${big}` }, { type: 'tool_use', id: 'B', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] }, // 3 — must survive as recent[1]
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'B', content: `edited ${big}` }] }, // 4 — the raw boundary (orphan if unfixed)
      { role: 'assistant', content: [{ type: 'text', text: `done ${big}` }] }, // 5
    ]
    const provider = createFakeProvider([[textDelta('SUMMARY OF OLDER')]])
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan }, { force: true })

    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('SUMMARY OF OLDER') // older → one user summary
    expect(messages[1].role).toBe('assistant') // recent starts on an assistant (turn-aligned), not a tool_result
    expect(orphanedToolResults(messages)).toEqual([]) // and no tool_result is left without its tool_use
  })

  it('force: compacts even under the threshold (reactive overflow path)', async () => {
    // Force should summarize the older half regardless of `auto` — with enough older mass that the swap
    // genuinely shrinks (the monotonicity guard rightly rejects a wrapper bigger than a toy older region).
    const msgs: Message[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'user' as const, content: `old ${i} ${'x'.repeat(180)}` })),
      { role: 'user', content: `latest ${'w'.repeat(36)}` },
    ]
    const provider = createFakeProvider([[textDelta('FORCED SUMMARY')]])
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan }, { force: true })
    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('FORCED SUMMARY')
  })
})

describe('measureWireOverhead — calibrate estimates against the backend\'s real prompt size', () => {
	it('first measurement taken whole; later ones EMA; overcounting estimates floor at 0', () => {
		// The live incident: est said 4,385, the wire said 8,191 — the wire adds ~3.8k we must not ignore.
		expect(measureWireOverhead(undefined, 8191, 4385)).toBe(3806)
		expect(measureWireOverhead(3806, 8000, 5000)).toBe(Math.round(3806 * 0.5 + 3000 * 0.5))
		expect(measureWireOverhead(3806, 1000, 5000)).toBe(Math.round(3806 * 0.5)) // real < est ⇒ measured floors at 0
	})
})

describe('compactor — recency shield (live-incident regression)', () => {
  // The incident (window-recheck, longctx-changelog-version): 8k window, the model's FIRST turn read the
  // changelog it needed; usage crossed `auto` (6,983 > 5,734) and the mask layer wiped the just-read file to
  // 341 tokens — the model had nothing left to answer from (0/3 after 8/8 pre-enforcement). The shield must
  // keep the newest results verbatim; over-auto-but-under-hard is a SOFT state, so nothing else may fire.
  const plan8k = planCompaction({ window: 8192 })

  /** The incident history: task → assistant fires Glob + 2 Reads → results incl. a ~5k-token changelog. */
  const incident = (): Message[] => [
    { role: 'user', content: 'Fill in src/meta.js from the project docs.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'g1', name: 'Glob', input: { pattern: '**/*.md' } },
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'CHANGELOG.md' } },
        { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'docs/UPGRADING.md' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'g1', content: 'CHANGELOG.md\ndocs/UPGRADING.md' },
        { type: 'tool_result', tool_use_id: 'r1', content: `## 4.2.0\n${'changelog '.repeat(1900)}` }, // ~19k chars ≈ 4.75k tok
        { type: 'tool_result', tool_use_id: 'r2', content: `Node 18+\n${'upgrading '.repeat(400)}` }, // ~4k chars ≈ 1k tok
      ],
    },
  ]

  it('over auto, under the ceiling, everything recent ⇒ NOTHING is evicted and no summary is attempted', async () => {
    const msgs = incident()
    expect(estimateTokens(msgs)).toBeGreaterThan(plan8k.auto) // the trigger really fires
    // …but the prompt still fits under the survival ceiling (effectiveWindow on small plans — output room).
    expect(estimateTokens(msgs)).toBeLessThan(Math.min(plan8k.hard, plan8k.effectiveWindow))
    const provider = createFakeProvider([]) // summarize must NOT be called
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan: plan8k })
    expect(kind).toBe('none')
    expect((messages[2].content as any)[1].content).toContain('changelog') // the read survives verbatim
    expect(provider.calls.length).toBe(0)
  })

  it('the shield rolls forward: once ≥5 newer results exist, the old big read IS evictable', async () => {
    const msgs = incident()
    for (let i = 0; i < 5; i++) {
      msgs.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `n${i}`, name: 'Read', input: { file_path: `f${i}.ts` } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `n${i}`, content: `file ${i} contents` }] },
      )
    }
    const provider = createFakeProvider([])
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan: plan8k })
    expect(kind).toBe('masked')
    expect((messages[2].content as any)[1].content).toMatch(/output masked/) // old changelog reclaimed
    expect((messages[4].content as any)[0].content).toContain('file 0 contents') // shielded newer results intact
  })

  it('overheadTokens counts toward every threshold: same messages, overhead pushes past the ceiling', async () => {
    // Live incident (window-gate-5): ~4k of system+tools+template overhead in an 8k window — the compactor
    // planned messages-only, Ollama front-truncated the prompt to 8191/8192 and the model got ONE output token.
    const msgs = incident() // soft-state WITHOUT overhead (asserted above)…
    const provider = createFakeProvider([])
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan: plan8k, overheadTokens: 4000 })
    expect(kind).not.toBe('none') // …but WITH real overhead the same history must be reclaimed
    expect(estimateTokens(messages) + 4000).toBeLessThan(8192) // and the wire prompt now fits the window
  })

  it('summarize is SKIPPED when the older region is too small to pay for the side-query', async () => {
    // Measured (json-repair-gate): late-game usage hovers just over auto (overhead counted), and every turn
    // paid a 60–120s summarize side-query — sometimes NET-NEGATIVE (wrapper > older; observed 2,114→2,797).
    // Two tasks timed out seconds from success. Tiny older ⇒ no LLM call at all.
    const msgs: Message[] = [
      { role: 'user', content: 'small task' }, // tiny older region
      { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: `x`.repeat(9000) }] }, // shielded
    ]
    const provider = createFakeProvider([]) // any summarize attempt would throw (no scripted turns)
    const overhead = 3500 // pushes past auto with a tiny older region
    const { kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan: plan8k, overheadTokens: overhead })
    expect(provider.calls.length).toBe(0) // the side-query was never spent
    expect(kind).not.toBe('summarized')
  })

  it('over the CEILING with nothing cheap left, summarize is MANDATORY (silent-truncation safety)', async () => {
    // Measured (item4-gate-2, delegate-prose): cheap layers reclaimed nothing (small results, old markers),
    // the worth-it pre-gate blocked summarize, and the loop proceeded over the ceiling — Ollama silently
    // front-truncated (input 8,159 + output 33 = exactly 8,192) and the model died with 33 tokens of room.
    const msgs: Message[] = [
      { role: 'user', content: 'the task' },
      // Text-heavy older region: only summarize can reclaim assistant text.
      ...Array.from({ length: 3 }, (_, i) => ({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: `analysis ${i} ${'y'.repeat(1600)}` }],
      })),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'r9', name: 'Read', input: { file_path: 'z.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r9', content: 'z'.repeat(12000) }] }, // shielded last read
    ]
    const provider = createFakeProvider([[textDelta('COMPRESSED ANALYSIS')]])
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan: plan8k, overheadTokens: 3000 })
    expect(kind).toBe('summarized') // worth-it was bypassed: over the ceiling there is no soft option
    expect(provider.calls.length).toBe(1)
    expect(estimateTokens(messages)).toBeLessThan(estimateTokens(msgs)) // and it genuinely shrank
  })

  it('a summarize that does not SHRINK the history is discarded (monotonicity guard)', async () => {
    const older: Message[] = Array.from({ length: 8 }, (_, i) => ({ role: 'user' as const, content: `old ${i} ${'x'.repeat(36)}` }))
    const recent: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: `r ${'z'.repeat(36)}` }] },
      { role: 'user', content: `latest ${'w'.repeat(36)}` },
    ]
    // The fake model writes a summary far LARGER than the older region it replaces.
    const provider = createFakeProvider([[textDelta('B'.repeat(4000))]])
    const { messages, kind } = await compactIfNeeded([...older, ...recent], { provider, model: 'fake', plan }, { force: true })
    expect(kind).not.toBe('summarized') // swap discarded — history may never GROW from compaction
    expect(messages.some((m) => String(m.content).includes('old 0'))) // original older still present
  })

  it('force (reactive overflow) still reclaims: shield shrinks to the very last result', async () => {
    const provider = createFakeProvider([])
    const { messages } = await compactIfNeeded(incident(), { provider, model: 'fake', plan: plan8k }, { force: true })
    const results = (messages[2].content as any) as { content: string }[]
    expect(results[1].content).toMatch(/output masked/) // survival wins: the big read goes
    expect(results[2].content).toContain('Node 18+') // …but the LAST result always survives (floor of 1)
  })

  it('summarize preserves the ORIGINAL TASK verbatim (weak summarizers lose it)', async () => {
    // Measured failure (window-gate-2, longctx-wire-modules): survival-mode summarize replaced the older
    // region — including the task statement — and the model's next reply was "please share the task".
    const older: Message[] = [
      { role: 'user', content: 'Reconstruct STAGE_ORDER in src/pipeline/order.js from the registerStage calls.' },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `noise ${i} ${'x'.repeat(36)}` })),
    ]
    const recent: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: `working ${'z'.repeat(36)}` }] },
      { role: 'user', content: `latest ${'w'.repeat(36)}` },
    ]
    const provider = createFakeProvider([[textDelta('SUMMARY WITHOUT THE TASK')]])
    const { messages, kind } = await compactIfNeeded([...older, ...recent], { provider, model: 'fake', plan }, { force: true })
    expect(kind).toBe('summarized')
    expect(messages[0].content).toContain('Reconstruct STAGE_ORDER') // the task survives VERBATIM
    expect(messages[0].content).toContain('SUMMARY WITHOUT THE TASK') // alongside the summary
  })

  it('summarize preserves the LATEST user instruction (harness steering) verbatim', async () => {
    // A just-injected steering message (delegation nudge, verify prompt) must survive a summarize that fires
    // before the model's next call — otherwise the harness steers into a void (caught by delegateNudge test).
    const older: Message[] = [
      { role: 'user', content: 'Original task here.' },
      ...Array.from({ length: 5 }, (_, i) => ({ role: 'user' as const, content: `noise ${i} ${'x'.repeat(36)}` })),
      { role: 'user', content: 'REMINDER: use the Subagent tool instead of reading more files.' },
    ]
    const recent: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: `ok ${'z'.repeat(36)}` }] },
      { role: 'user', content: `latest ${'w'.repeat(36)}` },
    ]
    const provider = createFakeProvider([[textDelta('SUMMARY')]])
    const { messages } = await compactIfNeeded([...older, ...recent], { provider, model: 'fake', plan }, { force: true })
    expect(messages[0].content).toContain('Original task here.')
    expect(messages[0].content).toContain('use the Subagent tool instead')
  })

  it('repeat compaction does NOT nest [Original task] headers (idempotent preservation)', async () => {
    const provider = createFakeProvider([[textDelta('SUMMARY ONE')], [textDelta('SUMMARY TWO')]])
    const start: Message[] = [
      { role: 'user', content: 'The one true task.' },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `noise ${i} ${'x'.repeat(36)}` })),
      { role: 'assistant', content: [{ type: 'text', text: `working ${'z'.repeat(36)}` }] },
      { role: 'user', content: `more ${'w'.repeat(36)}` },
    ]
    const once = await compactIfNeeded(start, { provider, model: 'fake', plan }, { force: true })
    const grown = [...once.messages, ...Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `later ${i} ${'y'.repeat(36)}` }))]
    const twice = await compactIfNeeded(grown, { provider, model: 'fake', plan }, { force: true })
    const head = String(twice.messages[0].content)
    expect(head.match(/\[Original task\]/g)?.length).toBe(1) // exactly one header
    expect(head).toContain('The one true task.') // …and the task itself survived two compactions
  })

  it('over HARD ⇒ survival mode: the shield must NOT hold the prompt above the wire ceiling', async () => {
    // The second live incident (window-gate-2, delegate-prose): ONE turn of 7 parallel reads hit ~32k estimated
    // in the 8k window. A 5-wide shield left 21k standing — over `hard`, so Ollama front-truncated the prompt
    // and the model lost its own history. Over hard the shield shrinks to 1 and the compactor MUST reclaim.
    const uses = Array.from({ length: 7 }, (_, i) => ({ type: 'tool_use' as const, id: `m${i}`, name: 'Read', input: { file_path: `docs/manual${i}.md` } }))
    const results = Array.from({ length: 7 }, (_, i) => ({ type: 'tool_result' as const, tool_use_id: `m${i}`, content: `manual ${i} ${'ops '.repeat(4500)}` })) // ~18k chars each
    const msgs: Message[] = [
      { role: 'user', content: 'Reconstruct RECOVERY_SEQUENCE from the six manuals.' },
      { role: 'assistant', content: uses },
      { role: 'user', content: results },
    ]
    expect(estimateTokens(msgs)).toBeGreaterThan(plan8k.hard) // the incident precondition
    const provider = createFakeProvider([])
    const { messages } = await compactIfNeeded(msgs, { provider, model: 'fake', plan: plan8k })
    expect(estimateTokens(messages)).toBeLessThan(plan8k.hard) // the invariant that was violated
    const out = (messages[2].content as any) as { content: string }[]
    expect(out[6].content).toContain('manual 6') // floor of 1: the last result still survives
  })
})
