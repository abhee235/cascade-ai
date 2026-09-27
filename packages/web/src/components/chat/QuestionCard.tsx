// QuestionCard — renders an AskUserQuestion (ADR-043). The agent loop is PARKED until the user submits, so the
// card is the resume button. Single- or multi-select per question, plus an always-present "Other" free-text
// (the model is told not to add its own). After submit it renders read-only with the chosen answers.
import { useState } from 'react'
import { Check, HelpCircle } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { useStore } from '@/lib/store'
import type { Item } from '@/lib/types'
import type { Answers } from '@cascade/core'
import { cn } from '@/lib/utils'

// A "question" is usually one short line, but ExitPlanMode passes a whole markdown PLAN as the prompt. Detect
// the rich case so we render it as markdown (headings / bold / code / lists) in a scrollable box instead of a
// raw single-line paragraph — and keep the Approve/Revise actions reachable below it.
const isRich = (s: string) => s.length > 180 || /\n|^#{1,6}\s|\*\*|`|^\s*[-*]\s/m.test(s)

export function QuestionCard({ item }: { item: Extract<Item, { kind: 'question' }> }) {
  const answerQuestion = useStore((s) => s.answerQuestion)
  const [picked, setPicked] = useState<Record<number, string[]>>({}) // question index → selected labels
  const [other, setOther] = useState<Record<number, string>>({}) // question index → "Other" text

  if (item.answered) {
    return (
      <div className="my-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-[13px]">
        {item.questions.map((q, qi) => (
          <div key={qi} className={qi > 0 ? 'mt-2' : ''}>
            <span className="text-xs mb-4 text-muted-foreground">{q.header}</span>
            <div className="flex items-start gap-1.5">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              {/* a resolved plan shows only its outcome (Approve/…), not the whole plan text again */}
              {isRich(q.question) ? (
                <span className="font-medium">{item.answered![q.question] || '—'}</span>
              ) : (
                <span>
                  <span className="text-muted-foreground">{q.question} </span>
                  <span className="font-medium">{item.answered![q.question] || '—'}</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicked((s) => {
      const cur = s[qi] ?? []
      if (multi) return { ...s, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      return { ...s, [qi]: [label] }
    })

  const canSubmit = item.questions.every((q, qi) => (picked[qi]?.length ?? 0) > 0 || (other[qi] ?? '').trim().length > 0)

  const submit = () => {
    const answers: Answers = {}
    item.questions.forEach((q, qi) => {
      const labels = [...(picked[qi] ?? [])]
      const o = (other[qi] ?? '').trim()
      if (o) labels.push(o)
      answers[q.question] = labels.join(', ')
    })
    answerQuestion(item.id, answers)
  }

  return (
    <div className="my-3 rounded-xl border border-primary/40 bg-card px-4 py-3 text-sm shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
        <HelpCircle className="h-3.5 w-3.5" /> Cascade needs your input
      </div>
      {item.questions.map((q, qi) => {
        const multi = !!q.multiSelect
        const sel = picked[qi] ?? []
        return (
          <div key={qi} className={qi > 0 ? 'mt-4 border-t border-border pt-3' : ''}>
            <span className="rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{q.header}</span>
            {isRich(q.question) ? (
              <div className="mt-2 mb-4 max-h-[46vh] overflow-y-auto rounded-lg border border-border bg-muted/30 px-3 py-2">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <Streamdown>{q.question}</Streamdown>
                </div>
              </div>
            ) : (
              <p className="mt-1.5 mb-6 text-[13px] font-medium">{q.question}</p>
            )}
            <div className="flex flex-col gap-1.5">
              {q.options.map((o) => {
                const on = sel.includes(o.label)
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => toggle(qi, o.label, multi)}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                      on ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent',
                    )}
                  >
                    <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border', multi ? 'rounded' : 'rounded-full', on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground')}>
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    <span>
                      <span className="text-[13px] font-medium">{o.label}</span>
                      {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                    </span>
                  </button>
                )
              })}
              <input
                type="text"
                placeholder="Other… (type your own)"
                value={other[qi] ?? ''}
                onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))}
                className="mt-0.5 rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </div>
          </div>
        )
      })}
      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className={cn('mt-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors', canSubmit ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground')}
      >
        Submit answer
      </button>
    </div>
  )
}
