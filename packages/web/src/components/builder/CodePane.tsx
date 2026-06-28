// CodePane.tsx — the Code tab (M4 + M2 diff): file tree (left) + Monaco on the right, with a Code/Diff
// toggle. Diff mode uses Monaco's DiffEditor to compare the file at the last git commit vs now — the proper
// home for diffs (the chat just shows a compact "Edited X +a −b" card that opens this). Read-only for now.

import Editor, { DiffEditor } from '@monaco-editor/react'
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
  const { fileTree, openFile, fileDiff, codeView, setCodeView, openFileInCode, theme, activeId } = useStore()

  if (!activeId) return <Center>Open a project to browse its files.</Center>

  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'light'
  const lang = openFile ? languageOf(openFile.path) : 'plaintext'
  const diffReady = fileDiff && openFile && fileDiff.path === openFile.path
  const editorOpts = { readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true } as const

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-border">
        <FileTree tree={fileTree} activePath={openFile?.path} onSelect={(p) => openFileInCode(p, codeView)} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {openFile ? (
          <>
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
              <span className="truncate font-mono text-xs text-muted-foreground">{openFile.path}</span>
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
                    options={{ ...editorOpts, renderSideBySide: false }}
                  />
                ) : (
                  <Center>Loading diff…</Center>
                )
              ) : (
                <Editor height="100%" theme={monacoTheme} path={openFile.path} language={lang} value={openFile.content} options={editorOpts} />
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
