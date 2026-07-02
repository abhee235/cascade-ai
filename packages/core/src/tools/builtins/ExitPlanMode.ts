// tools/builtins/ExitPlanMode.ts — present the finished plan and request the user's APPROVAL (ADR-044).
// This IS the approval gate — the model must not use AskUserQuestion to ask "is my plan ok?". Reuses the
// AskUserQuestion round-trip (requiresUserInteraction + the scheduler park + the QuestionCard UI): `toQuestions` renders the plan with Approve/Revise options; `applyAnswers` flips the
// permission mode back on approval (restoring the PRIOR mode — 'bypass' for the web, 'default' for the extension).

import { z } from 'zod'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  plan: z.string().min(1).describe('Your complete implementation plan (markdown) for the user to review — the concrete steps you will take once approved.'),
})

export const ExitPlanModeTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'ExitPlanMode',
  description: `Present your finished implementation plan and request the user's approval to start writing code. Use this ONLY when you're in plan mode and the plan is complete — it IS the approval request (do NOT use AskUserQuestion to ask whether the plan is okay). On approval, writes unlock and you implement; if the user wants changes, revise and call this again.`,
  inputSchema,
  activitySummary: () => 'Requesting plan approval',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  requiresUserInteraction: () => true, // ADR-044: the scheduler runs the approval round-trip via ctx.ask

  toQuestions: (input) => [
    {
      question: `Review this plan and approve it to start implementing:\n\n${input.plan}`,
      header: 'Plan',
      options: [
        { label: 'Approve', description: 'The plan looks good — start implementing.' },
        { label: 'Revise', description: "Don't implement yet — I have changes (add them in Other).", },
      ],
      multiSelect: false,
    },
  ],

  async applyAnswers(_input, answers, ctx) {
    const choice = Object.values(answers)[0] ?? ''
    if (/approve/i.test(choice)) {
      const perm = ctx.permission
      // Only RESTORE a saved prior mode. If ExitPlanMode is called without a preceding EnterPlanMode
      // (priorMode undefined — e.g. a weak model skips EnterPlanMode), leave the mode untouched: forcing
      // 'default' would make the web (bypass) prompt for every write with no permission UI → hang. If we're
      // genuinely in plan mode with no saved prior, fall back to 'default' so writes aren't left blocked.
      if (perm && perm.state.priorMode !== undefined) {
        perm.state.mode = perm.state.priorMode
        perm.state.priorMode = undefined
      } else if (perm && perm.state.mode === 'plan') {
        perm.state.mode = 'default'
      }
      return { content: 'The user APPROVED the plan. Plan mode is exited and writes are unlocked — implement the plan now, step by step.' }
    }
    // "Revise" or free-text feedback → stay in plan mode and iterate.
    const feedback = choice && !/^revise$/i.test(choice) ? ` Their feedback: "${choice}".` : ''
    return { content: `The user did NOT approve the plan.${feedback} You are still in plan mode — revise your approach accordingly and call ExitPlanMode again with the updated plan.`, isError: true }
  },

  // Only reached with no interactive channel (headless / non-interactive). Can't get approval → tell the model.
  async call() {
    return { content: 'No interactive channel to request plan approval. Ask the user directly whether to proceed with the plan.', isError: true }
  },
}
