// CodePane.tsx — the Code tab (M4 + M2 diff, editable in M9): file tree (left) + Monaco on the right, with a
// Code/Diff toggle. Code view is now EDITABLE — edits autosave (debounced) via file:write and Vite HMR picks
// them up; the agent can still edit the same files (its turns checkpoint, so a hand-edit is recoverable). Diff
// mode stays read-only (Monaco DiffEditor: file at last git commit vs now).

import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { AlertTriangle, ChevronRight, Files, Folder, Search, X } from 'lucide-react'
import type { FileNode } from '@cascade/app-protocol'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { FileTree } from './FileTree'
import { FileGlyph } from './fileGlyph'

function languageOf(path: string): string {
  switch (path.split('.').pop()?.toLowerCase()) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
      return 'markdown'
    default:
      return 'plaintext'
  }
}

const nameOf = (path: string) => path.split('/').pop() ?? path

/** A clean-ish display name for the explorer header. Cascade uses the first PROMPT as a project's name, so
 *  prefer a quoted term when present (`Build "Simmer" …` → Simmer; `landing page for "Fernwood"` → Fernwood);
 *  otherwise fall back to the full name (the header truncates it). */
function projectDisplayName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const quoted = name.match(/["'“”‘’]([^"'“”‘’]{2,40})["'“”‘’]/)
  return quoted ? quoted[1].trim() : name
}

const Center = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">{children}</div>
)

/** All file paths in a tree, depth-first (folders dropped) — the corpus the Search view filters over. */
function flattenFiles(nodes: FileNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'dir') flattenFiles(n.children ?? [], acc)
    else acc.push(n.path)
  }
  return acc
}

/** The sidebar's Search VIEW. The left panel is a tabbed area (like VS Code): the activity-bar Search icon
 *  swaps the whole explorer for this — a query box + a flat, clickable list of matching files — instead of
 *  cramming a filter box on top of the tree. Own local query state so switching views doesn't lose it. */
function SearchPanel({ tree, onOpen }: { tree: FileNode[]; onOpen: (path: string) => void }) {
  const [q, setQ] = useState('')
  const files = useMemo(() => flattenFiles(tree), [tree])
  const query = q.trim().toLowerCase()
  const results = query ? files.filter((f) => f.toLowerCase().includes(query)).slice(0, 200) : []
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files by name…"
          className="w-full rounded border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-ring"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!query ? (
          <p className="px-3 py-2 text-[12px] text-muted-foreground/70">Type to search files by name.</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-muted-foreground/70">No files match “{q}”.</p>
        ) : (
          results.map((f) => {
            const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
            return (
              <button key={f} onClick={() => onOpen(f)} title={f} className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] hover:bg-accent/50">
                <FileGlyph path={f} className="h-4 w-4" />
                <span className="shrink-0 truncate">{nameOf(f)}</span>
                {dir && <span className="min-w-0 truncate text-xs text-muted-foreground/60">{dir}</span>}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export function CodePane() {
  const { fileTree, openTabs, openFile, fileDiff, codeView, setCodeView, openFileInCode, closeTab, saveFile, createFile, createFolder, renameEntry, deleteEntry, refreshFiles, fileError, theme, activeId, projects } = useStore()

  // Local editing buffer so typing is smooth; reset when the open file (path or externally-changed content) changes.
  const [draft, setDraft] = useState(openFile?.content ?? '')
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [sidebarView, setSidebarView] = useState<'files' | 'search'>('files') // activity-bar tabs the left panel (VS Code-style)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    setDraft(openFile?.content ?? '')
    setSaved('idle')
  }, [openFile?.path, openFile?.content])

  if (!activeId) return <Center>Open a project to browse its files.</Center>

  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'light'
  const lang = openFile ? languageOf(openFile.path) : 'plaintext'
  const diffReady = fileDiff && openFile && fileDiff.path === openFile.path
  const baseOpts = { minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true } as const

  const onEdit = (value?: string) => {
    if (!openFile) return
    const content = value ?? ''
    setDraft(content)
    setSaved('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      saveFile(openFile.path, content)
      setSaved('saved')
    }, 600)
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col border-r border-border">
        {/* Activity bar (Files · Search) — the left panel is a TABBED area: each icon swaps the whole view
            below (VS Code-style), not an inline box. Aligned in height with the editor tab strip (h-9). */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          {([
            { view: 'files', title: 'Explorer', Icon: Files },
            { view: 'search', title: 'Search', Icon: Search },
          ] as const).map(({ view, title, Icon }) => (
            <button
              key={view}
              title={title}
              onClick={() => setSidebarView(view)}
              className={cn('flex h-6 w-6 items-center justify-center rounded', sidebarView === view ? 'border-bottom border-primary text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <Icon className="h-5 w-5" />
            </button>
          ))}
        </div>
        {sidebarView === 'search' ? (
          <SearchPanel tree={fileTree} onOpen={(p) => openFileInCode(p, codeView)} />
        ) : (
          <FileTree
            tree={fileTree}
            activePath={openFile?.path}
            label={projectDisplayName(projects.find((p) => p.id === activeId)?.name)}
            onSelect={(p) => openFileInCode(p, codeView)}
            onCreateFile={createFile}
            onCreateFolder={createFolder}
            onRename={renameEntry}
            onDelete={deleteEntry}
            onRefresh={refreshFiles}
          />
        )}
        {fileError && (
          <div className="mt-auto flex items-start gap-1.5 border-t border-border bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0">{fileError}</span>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {openFile ? (
          <>
            {/* VS Code-style editor tab strip: one tab per open file (icon + name + close), active tab lifted. */}
            <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/30">
              <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
                {openTabs.map((path) => {
                  const active = openFile.path === path
                  return (
                    <div
                      key={path}
                      role="tab"
                      aria-selected={active}
                      title={path}
                      onClick={() => !active && openFileInCode(path, codeView)}
                      onAuxClick={(e) => e.button === 1 && (e.preventDefault(), closeTab(path))} // middle-click closes
                      className={cn(
                        'group flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-t-2 border-border px-3 text-[13px]',
                        active ? 'border-t-primary bg-background text-foreground' : 'border-t-transparent bg-muted/30 text-muted-foreground hover:bg-background/60',
                      )}
                    >
                      <FileGlyph path={path} className="h-4 w-4" />
                      <span className="truncate">{nameOf(path)}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTab(path)
                        }}
                        title="Close"
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent',
                          active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100',
                        )}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
              {/* editor actions: save indicator + Code/Diff toggle */}
              <div className="flex shrink-0 items-center gap-2 border-l border-border px-2">
                {codeView === 'code' && saved !== 'idle' && (
                  <span className="text-xs text-muted-foreground/70">{saved === 'saving' ? 'saving…' : 'saved'}</span>
                )}
                <div className="flex items-center overflow-hidden rounded-md border border-border text-xs">
                  {(['code', 'diff'] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setCodeView(v)}
                      className={cn('px-2 py-0.5 capitalize', codeView === v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Breadcrumb: the active file's path as folder/file segments (VS Code's path breadcrumb).
                h-8 matches the explorer header so the two columns' second rows line up. */}
            <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-3 text-xs text-muted-foreground">
              {openFile.path.split('/').map((seg, i, arr) => {
                const isLast = i === arr.length - 1
                return (
                  <span key={i} className="flex shrink-0 items-center gap-0.5">
                    {i > 0 && <ChevronRight className="h-3 w-3 opacity-50" />}
                    {isLast ? <FileGlyph path={openFile.path} className="h-3 w-3" /> : <Folder className="h-3 w-3 shrink-0 text-blue-500" />}
                    <span className={cn(isLast && 'text-foreground')}>{seg}</span>
                  </span>
                )
              })}
            </div>

            <div className="min-h-0 flex-1">
              {codeView === 'diff' ? (
                diffReady ? (
                  <DiffEditor
                    height="100%"
                    theme={monacoTheme}
                    language={lang}
                    original={fileDiff.original}
                    modified={fileDiff.modified}
                    options={{ ...baseOpts, readOnly: true, renderSideBySide: false }}
                  />
                ) : (
                  <Center>Loading diff…</Center>
                )
              ) : (
                <Editor height="100%" theme={monacoTheme} path={openFile.path} language={lang} value={draft} onChange={onEdit} options={baseOpts} />
              )}
            </div>
          </>
        ) : (
          <Center>Select a file to view it.</Center>
        )}
      </div>
    </div>
  )
}
