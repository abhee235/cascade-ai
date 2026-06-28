// FileTree.tsx — the Code pane's file explorer (M4 + M9 CRUD). VS Code-style: a header toolbar (new file /
// new folder), a right-click context menu (new file/folder on dirs, rename, delete on any entry), and inline
// inputs for creating/renaming. Expanded state + the active context-menu/edit are held here (not per node) so
// creating inside a collapsed folder can auto-expand it. The actual fs ops happen server-side (guarded).

import { createContext, useContext, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, File as FileIcon, FilePlus, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import type { FileNode } from '@cascade/app-protocol'
import { cn } from '@/lib/utils'

type Edit = { mode: 'rename' | 'newFile' | 'newFolder'; path: string } // path = node (rename) or parent dir (create); '' = root
type Menu = { x: number; y: number; node: FileNode }

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const nameOf = (p: string) => p.split('/').pop() ?? p
const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

interface TreeCtx {
  activePath?: string
  expanded: Set<string>
  toggle: (path: string) => void
  onSelect: (p: string) => void
  openMenu: (e: React.MouseEvent, node: FileNode) => void
  edit: Edit | null
  beginCreate: (parent: string, kind: 'file' | 'dir') => void
  submitEdit: (name: string) => void
  cancelEdit: () => void
  selPath: string | null // the tree's selected node (drives where the toolbar creates + the highlight)
  select: (node: FileNode) => void
}
const Ctx = createContext<TreeCtx | null>(null)

// The inline input used for both "new file/folder" and "rename", with a small key-hint underneath.
function EditInput({ initial }: { initial: string }) {
  const ctx = useContext(Ctx)!
  const [val, setVal] = useState(initial)
  return (
    <div>
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') ctx.submitEdit(val.trim())
          else if (e.key === 'Escape') ctx.cancelEdit()
        }}
        onBlur={() => ctx.cancelEdit()}
        className="w-full rounded border border-ring bg-background px-1 py-0.5 text-xs outline-none"
        placeholder="name…"
      />
      <div className="mt-0.5 text-[10px] text-muted-foreground/70">Enter to save · Esc to cancel</div>
    </div>
  )
}

function Node({ node, depth }: { node: FileNode; depth: number }) {
  const ctx = useContext(Ctx)!
  const pad = { paddingLeft: `${depth * 12 + 8}px` }
  const renaming = ctx.edit?.mode === 'rename' && ctx.edit.path === node.path

  if (node.type === 'dir') {
    const open = ctx.expanded.has(node.path)
    const creatingHere = ctx.edit && ctx.edit.mode !== 'rename' && ctx.edit.path === node.path
    return (
      <div>
        {renaming ? (
          <div style={pad} className="py-0.5 pr-1.5">
            <EditInput initial={node.name} />
          </div>
        ) : (
          <button
            className={cn(
              'flex w-full items-center gap-1 py-0.5 text-xs hover:bg-accent/50',
              ctx.selPath === node.path ? 'bg-accent text-foreground' : 'text-foreground/90',
            )}
            style={pad}
            onClick={() => {
              ctx.select(node)
              ctx.toggle(node.path)
            }}
            onContextMenu={(e) => ctx.openMenu(e, node)}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            {open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-500" /> : <Folder className="h-3.5 w-3.5 shrink-0 fill-blue-500/20 text-blue-500" />}
            <span className="truncate">{node.name}</span>
          </button>
        )}
        {open && (
          <div>
            {creatingHere && (
              <div style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }} className="py-0.5 pr-1.5">
                <EditInput initial="" />
              </div>
            )}
            {node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
          </div>
        )}
      </div>
    )
  }

  if (renaming)
    return (
      <div style={pad} className="py-0.5 pr-1.5">
        <EditInput initial={node.name} />
      </div>
    )
  return (
    <button
      className={cn(
        'flex w-full items-center gap-1 py-0.5 text-xs hover:bg-accent/50',
        ctx.activePath === node.path ? 'bg-accent text-foreground' : 'text-foreground/90',
      )}
      style={pad}
      onClick={() => {
        ctx.select(node)
        ctx.onSelect(node.path)
      }}
      onContextMenu={(e) => ctx.openMenu(e, node)}
    >
      <span className="h-3.5 w-3.5 shrink-0" aria-hidden /> {/* aligns the file icon under sibling folder icons (no chevron) */}
      <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

export function FileTree({
  tree,
  activePath,
  onSelect,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
}: {
  tree: FileNode[]
  activePath?: string
  onSelect: (p: string) => void
  onCreateFile: (path: string) => void
  onCreateFolder: (path: string) => void
  onRename: (path: string, to: string) => void
  onDelete: (path: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.filter((n) => n.type === 'dir').map((n) => n.path)))
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [sel, setSel] = useState<{ path: string; isDir: boolean } | null>(null)

  // Where the toolbar's New File/Folder creates: inside the selected folder, or the selected file's folder, else root.
  const targetDir = sel ? (sel.isDir ? sel.path : parentOf(sel.path)) : ''

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const toggle = (path: string) => setExpanded((s) => (s.has(path) ? new Set([...s].filter((p) => p !== path)) : new Set(s).add(path)))
  const beginCreate = (parent: string, kind: 'file' | 'dir') => {
    if (parent) setExpanded((s) => new Set(s).add(parent)) // reveal the input inside a collapsed folder
    setEdit({ mode: kind === 'file' ? 'newFile' : 'newFolder', path: parent })
    setMenu(null)
  }
  const cancelEdit = () => setEdit(null)
  const submitEdit = (name: string) => {
    const e = edit
    setEdit(null)
    if (!e || !name) return
    if (e.mode === 'rename') onRename(e.path, joinPath(parentOf(e.path), name))
    else if (e.mode === 'newFile') onCreateFile(joinPath(e.path, name))
    else onCreateFolder(joinPath(e.path, name))
  }

  const ctx: TreeCtx = {
    activePath,
    expanded,
    toggle,
    onSelect,
    openMenu: (e, node) => {
      e.preventDefault()
      setSel({ path: node.path, isDir: node.type === 'dir' }) // right-click selects, so the menu/highlight match
      setMenu({ x: e.clientX, y: e.clientY, node })
    },
    edit,
    beginCreate,
    submitEdit,
    cancelEdit,
    selPath: sel?.path ?? null,
    select: (node) => setSel({ path: node.path, isDir: node.type === 'dir' }),
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border px-2">
          <span className="flex-1 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Explorer</span>
          <button title={`New file${targetDir ? ` in ${targetDir}/` : ''}`} onClick={() => beginCreate(targetDir, 'file')} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <FilePlus className="h-3.5 w-3.5" />
          </button>
          <button title={`New folder${targetDir ? ` in ${targetDir}/` : ''}`} onClick={() => beginCreate(targetDir, 'dir')} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {edit && edit.mode !== 'rename' && edit.path === '' && (
            <div className="px-2 py-0.5">
              <EditInput initial="" />
            </div>
          )}
          {tree.length === 0 && !edit ? (
            <div className="p-3 text-xs text-muted-foreground/70">No files. Use the buttons above to add one.</div>
          ) : (
            tree.map((n) => <Node key={n.path} node={n} depth={0} />)
          )}
        </div>
      </div>

      {menu && (
        <div className="fixed z-50 min-w-[150px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.node.type === 'dir' && (
            <>
              <MenuItem icon={FilePlus} label="New file" onClick={() => beginCreate(menu.node.path, 'file')} />
              <MenuItem icon={FolderPlus} label="New folder" onClick={() => beginCreate(menu.node.path, 'dir')} />
              <div className="my-1 h-px bg-border" />
            </>
          )}
          <MenuItem icon={Pencil} label="Rename" onClick={() => { setEdit({ mode: 'rename', path: menu.node.path }); setMenu(null) }} />
          <MenuItem
            icon={Trash2}
            label="Delete"
            danger
            onClick={() => {
              setMenu(null)
              if (window.confirm(`Delete "${nameOf(menu.node.path)}"? This can't be undone from here.`)) onDelete(menu.node.path)
            }}
          />
        </div>
      )}
    </Ctx.Provider>
  )
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof FilePlus; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent', danger ? 'text-destructive hover:text-destructive' : 'text-foreground')}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  )
}
