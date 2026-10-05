// HomePage.tsx — the landing view: "What do you want to build?" + a big prompt box. Submitting
// creates a project (from a template) and jumps into its builder with the prompt as the first message.

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ImagePlus, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ModelPicker } from '@/components/chat/ModelPicker'

export function HomePage() {
  const { templates, startBuild, connected } = useStore()
  const [prompt, setPrompt] = useState('')
  const [templateId, setTemplateId] = useState('')
  // ADR-086: reference images for the first build — the planner studies them before it writes the plan.
  const [images, setImages] = useState<{ id: string; name: string; dataUrl: string }[]>([])
  // Reads still in flight: a large screenshot takes a beat to read, and building before it lands would quietly
  // drop it from the plan (review, 2026-10-04) — so the build waits for them.
  const [reading, setReading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Default to the first template once they load over the socket.
  useEffect(() => {
    if (templates.length && !templateId) setTemplateId(templates[0].id)
  }, [templates, templateId])

  const addImages = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue // Home takes images only; other files go in the chat
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 6)}`
      const reader = new FileReader()
      setReading((n) => n + 1)
      reader.onload = () => setImages((a) => [...a, { id, name: file.name, dataUrl: String(reader.result) }])
      reader.onloadend = () => setReading((n) => n - 1) // after load, error or abort alike
      reader.readAsDataURL(file)
    }
  }

  const go = () => {
    if (!prompt.trim() || !connected || reading > 0) return
    startBuild(prompt, templateId || undefined, images.map((i) => i.dataUrl))
    setPrompt('')
    setImages([])
  }
  const blank = templateId === 'none'

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">What do you want to build?</h1>

      <div
        className="relative w-full max-w-2xl rounded-xl border border-border bg-card p-2 shadow-sm"
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files.length) addImages(e.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 text-xs font-medium text-primary">
            Drop images to use as the design reference
          </div>
        )}
        <Textarea
          autoFocus
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) addImages(e.clipboardData.files)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              go()
            }
          }}
          // ADR-084 Phase 2: a stable accessible name. The placeholder swaps with connection state, so it
          // cannot be the name — and a placeholder is not an accessible name in the first place.
          aria-label="Describe the app to build"
          placeholder={connected ? 'Ask Cascade to build…' : 'connecting to server…'}
          className="min-h-20 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pb-2">
            {images.map((a) => (
              <div key={a.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-background py-1 pl-1 pr-2 text-xs">
                <img src={a.dataUrl} alt={a.name} className="h-8 w-8 rounded object-cover" />
                <span className="max-w-[140px] truncate text-muted-foreground">{a.name}</span>
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setImages((all) => all.filter((x) => x.id !== a.id))} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImages(e.target.files)
            e.target.value = '' // the same file can be picked again after removing it
          }}
        />
        <div className="flex items-center gap-2 px-1 pb-1">
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Attach images" title="Attach images — the plan is designed from them" onClick={() => fileRef.current?.click()}>
            <ImagePlus className="h-4 w-4" />
          </Button>
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
          {/* choose the model to build with before starting (switches the active model, like the composer) */}
          <ModelPicker />
          <Button size="icon" className="ml-auto rounded-full" disabled={!connected || !prompt.trim() || reading > 0} onClick={go} title={reading > 0 ? 'Reading images…' : 'Build'}>
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground/70">
        {blank
          ? `Cascade starts from a blank project and designs it from your prompt${images.length ? ' and your images' : ''}.`
          : `Cascade scaffolds a ${templates.find((t) => t.id === templateId)?.name ?? 'new'} app, then builds it from your prompt${images.length ? ', designed from your images' : ''}.`}
      </p>
    </div>
  )
}
