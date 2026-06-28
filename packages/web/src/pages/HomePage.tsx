// HomePage.tsx — the landing view: "What do you want to build?" + a big prompt box. Submitting
// creates a project (from a template) and jumps into its builder with the prompt as the first message.

import { useEffect, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function HomePage() {
  const { templates, startBuild, connected } = useStore()
  const [prompt, setPrompt] = useState('')
  const [templateId, setTemplateId] = useState('')

  // Default to the first template once they load over the socket.
  useEffect(() => {
    if (templates.length && !templateId) setTemplateId(templates[0].id)
  }, [templates, templateId])

  const go = () => {
    if (!prompt.trim() || !connected) return
    startBuild(prompt, templateId || undefined)
    setPrompt('')
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">What do you want to build?</h1>

      <div className="w-full max-w-2xl rounded-xl border border-border bg-card p-2 shadow-sm">
        <Textarea
          autoFocus
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              go()
            }
          }}
          placeholder={connected ? 'Ask Cascade to build…' : 'connecting to server…'}
          className="min-h-20 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-2 px-1 pb-1">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger size="sm" className="w-auto gap-1.5 text-xs">
              <SelectValue placeholder="Template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-xs">
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="icon" className="ml-auto rounded-full" disabled={!connected || !prompt.trim()} onClick={go} title="Build">
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground/70">
        Cascade scaffolds a {templates.find((t) => t.id === templateId)?.name ?? 'new'} app, then builds it from your prompt.
      </p>
    </div>
  )
}
