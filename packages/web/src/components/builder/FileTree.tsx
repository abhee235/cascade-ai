import { useState } from 'react'
import { ChevronDown, ChevronRight, File as FileIcon } from 'lucide-react'
import type { FileNode } from '@cascade/app-protocol'
import { cn } from '@/lib/utils'

function Node({ node, depth, activePath, onSelect }: { node: FileNode; depth: number; activePath?: string; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 1) // top level expanded by default
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.type === 'dir') {
    return (
      <div>
        <button
          className="flex w-full items-center gap-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          style={pad}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} activePath={activePath} onSelect={onSelect} />)}
      </div>
    )
  }
  return (
    <button
      className={cn(
        'flex w-full items-center gap-1.5 py-0.5 text-xs hover:bg-accent/50',
        activePath === node.path ? 'bg-accent text-foreground' : 'text-muted-foreground',
      )}
      style={pad}
      onClick={() => onSelect(node.path)}
    >
      <FileIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

export function FileTree({ tree, activePath, onSelect }: { tree: FileNode[]; activePath?: string; onSelect: (p: string) => void }) {
  if (!tree.length) return <div className="p-3 text-xs text-muted-foreground/70">No files.</div>
  return (
    <div className="py-1">
      {tree.map((n) => (
        <Node key={n.path} node={n} depth={0} activePath={activePath} onSelect={onSelect} />
      ))}
    </div>
  )
}
