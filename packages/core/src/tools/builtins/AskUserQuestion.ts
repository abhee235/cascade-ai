// tools/builtins/AskUserQuestion.ts — ask the user a structured multiple-choice question mid-task (ADR-043).
// The tool's EFFECT is a round-trip to the user, so the SCHEDULER intercepts it (like a permission 'ask'):
// it yields a `question` event and awaits ctx.ask — call() only runs when there's NO interactive channel
// (headless), returning a clear error.
//
// Why for a weak model: a weak local model guesses wrong on ambiguity far more than a frontier model. A
// structured "ask instead of assume" channel — offered PROACTIVELY when genuinely blocked — is a real
// reliability win (faculty E). The description is TIER-SIZED (ADR-037) and carries a weak-model nudge to
// ask only when blocked, not to offload decisions it can make or discover itself.

import { z } from 'zod'
import type { Tool } from '../Tool'
import type { Answers } from '../../protocol'

const optionSchema = z.object({
  label: z.string().min(1).describe('Concise choice text (1–5 words) the user selects.'),
  description: z.string().describe('What this option means / what happens if chosen (trade-offs).'),
  preview: z.string().optional().describe('Optional artifact (a mockup or code snippet) to compare visually. Single-select only.'),
})

const questionSchema = z.object({
  question: z.string().min(1).describe('The full question, ending in "?". Clear and specific.'),
  header: z.string().min(1).max(12).describe('Very short chip label (≤12 chars), e.g. "Auth method".'),
  options: z.array(optionSchema).min(2).max(4).describe('2–4 distinct, mutually-exclusive choices (unless multiSelect). Do NOT add an "Other" option — the UI always provides one.'),
  multiSelect: z.boolean().optional().describe('Allow multiple selections (choices that aren\'t mutually exclusive). Default false.'),
})

const inputSchema = z
  .object({
    questions: z.array(questionSchema).min(1).max(4).describe('1–4 questions to ask at once.'),
  })
  // Uniqueness refine: distinct question texts + distinct option labels within each question.
  .refine(
    (d) =>
      new Set(d.questions.map((q) => q.question)).size === d.questions.length &&
      d.questions.every((q) => new Set(q.options.map((o) => o.label)).size === q.options.length),
    { message: 'Each question needs its own text, and no two options in one question may share a label.' },
  )

// ADR-037: tier-sized. The when-to-use guidance is advisory (compressible); the conventions ("Other" is
// automatic, recommend-first) are kept at every tier because they change how the model forms the call.
const DESCRIPTION_FULL = `Ask the user one or more structured multiple-choice questions and wait for their answer — use it to resolve ambiguity, gather a preference, or get a decision only the user can make, MID-task, without stopping.

Ask PROACTIVELY when you're genuinely blocked on a choice — but do NOT offload decisions you can make yourself or discover from the code. Prefer investigating first; ask only when the answer isn't in the repo and the options are real forks.

Conventions:
- The UI always adds an "Other" free-text option — never include one yourself.
- If you recommend an option, make it the FIRST option and end its label with "(Recommended)".
- Use multiSelect: true only when the choices aren't mutually exclusive.
- Each option needs a short label + a description of what choosing it means.`

const DESCRIPTION_LEAN = `Ask the user a structured multiple-choice question and wait for the answer — for a decision only they can make. Ask only when genuinely blocked (investigate the code first). The UI adds "Other" automatically (don't include one). Put a recommended option first, labelled "(Recommended)". multiSelect only for non-exclusive choices.`

const DESCRIPTION_MINIMAL = `Ask the user a multiple-choice question when you're genuinely blocked on a decision only they can make (investigate first). "Other" is added automatically; put any recommended option first.`

const description = (tier: 'minimal' | 'lean' | 'full'): string =>
  tier === 'full' ? DESCRIPTION_FULL : tier === 'lean' ? DESCRIPTION_LEAN : DESCRIPTION_MINIMAL

/** Format the user's answers into a tool_result the model can act on (used by the scheduler on the ask path). */
export function formatAnswers(answers: Answers): string {
  const lines = Object.entries(answers).map(([q, a]) => `- ${q} → ${a}`)
  return lines.length ? `The user answered:\n${lines.join('\n')}` : 'The user provided no answer.'
}

export const AskUserQuestionTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'AskUserQuestion',
  description, // tier-sized (ADR-037)
  inputSchema,
  activitySummary: (input) => `Asking: ${input.questions[0]?.header ?? 'question'}`,
  isReadOnly: () => true, // no filesystem effect
  isConcurrencySafe: () => true,
  requiresUserInteraction: () => true, // ADR-043: the scheduler handles the round-trip via ctx.ask

  // Only reached when there's NO interactive channel (headless / non-interactive run). With a channel, the
  // scheduler intercepts (yields `question`, awaits ctx.ask) and this never runs.
  async call() {
    return {
      content: 'No interactive channel is available to ask the user (non-interactive session). Proceed with a sensible default and state the assumption you made.',
      isError: true,
    }
  },
}
