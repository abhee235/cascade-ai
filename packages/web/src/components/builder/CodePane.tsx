// CodePane.tsx — the Code tab (M4 + M2 diff, editable in M9): file tree (left) + Monaco on the right, with a
// Code/Diff toggle. Code view is now EDITABLE — edits autosave (debounced) via file:write and Vite HMR picks
// them up; the agent can still edit the same files (its turns checkpoint, so a hand-edit is recoverable). Diff
// mode stays read-only (Monaco DiffEditor: file at last git commit vs now).

import { useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { AlertTriangle } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { FileTree } from './FileTree'

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

const Center = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{children}</div>
)

export function CodePane() {
  const { fileTree, openFile, fileDiff, codeView, setCodeView, openFileInCode, saveFile, createFile, createFolder, renameEntry, deleteEntry, fileError, theme, activeId } = useStore()

  // Local editing buffer so typing is smooth; reset when the open file (path or externally-changed content) changes.
  const [draft, setDraft] = useState(openFile?.content ?? '')
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
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
        <FileTree
          tree={fileTree}
          activePath={openFile?.path}
          onSelect={(p) => openFileInCode(p, codeView)}
          onCreateFile={createFile}
          onCreateFolder={createFolder}
          onRename={renameEntry}
          onDelete={deleteEntry}
        />
        {fileError && (
          <div className="mt-auto flex items-start gap-1.5 border-t border-border bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0">{fileError}</span>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {openFile ? (
          <>
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
              <span className="truncate font-mono text-xs text-muted-foreground">{openFile.path}</span>
              {codeView === 'code' && saved !== 'idle' && (
                <span className="text-[10px] text-muted-foreground/70">{saved === 'saving' ? 'saving…' : 'saved'}</span>
              )}
              <div className="ml-auto flex items-center overflow-hidden rounded-md border border-border text-[11px]">
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
