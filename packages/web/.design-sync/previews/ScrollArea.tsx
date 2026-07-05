import { ScrollArea, Separator } from '@cascade/web'

const files = [
  'App.tsx', 'main.tsx', 'index.css', 'BuilderPane.tsx', 'ChatPanel.tsx',
  'CodePane.tsx', 'FileTree.tsx', 'TerminalPane.tsx', 'PreviewPane.tsx', 'utils.ts',
]

export const FileList = () => (
  <ScrollArea className="h-56 w-64 rounded-md border">
    <div className="p-3">
      <div className="mb-2 text-sm font-medium leading-none">src/</div>
      {files.map((f) => (
        <div key={f}>
          <div className="py-1.5 font-mono text-sm text-muted-foreground">{f}</div>
          <Separator />
        </div>
      ))}
    </div>
  </ScrollArea>
)
