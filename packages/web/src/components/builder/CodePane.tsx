// CodePane.tsx — the Code tab (M4): file tree (left) + Monaco editor (right). Read-only for now — you watch
// the agent create/edit files; gated saving comes later. The tree + content come over the protocol
// (`files` / `fileContent`), refreshed on project open and after each turn.

import Editor from '@monaco-editor/react'
import { useStore } from '@/lib/store'
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

export function CodePane() {
  const { fileTree, openFile, requestFile, theme, activeId } = useStore()

  if (!activeId) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Open a project to browse its files.</div>

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-border">
        <FileTree tree={fileTree} activePath={openFile?.path} onSelect={requestFile} />
      </div>
      <div className="min-w-0 flex-1">
        {openFile ? (
          <Editor
            height="100%"
            theme={theme === 'dark' ? 'vs-dark' : 'light'}
            path={openFile.path}
            language={languageOf(openFile.path)}
            value={openFile.content}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Select a file to view it.</div>
        )}
      </div>
    </div>
  )
}
