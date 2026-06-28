// @cascade/app-protocol — the app/builder WIRE protocol (the wrapper layer).
//
// @cascade/core's protocol describes ONE agent session (ActivityEvent / InboundMessage). But a
// prompt-to-app builder also has concepts that span MANY sessions and the app surface itself —
// projects, and later live preview, terminal, versions, file browsing. Those are NOT one session's
// activity, so they must NOT live in core. They live here, in the wrapper layer, and the server + web
// frontends speak them ALONGSIDE core's session protocol.
//
// Rule (see PLAN): managing/composing sessions or an app/UI surface ⇒ a BuilderEvent/BuilderCommand here,
// never a core ActivityEvent. This package depends on NOTHING (not even core): the union
// `ActivityEvent ∪ BuilderEvent` is formed at the frontends/server, keeping the layers decoupled.

/** A project = a workspace dir + its own long-lived CascadeSession, owned by the server's ProjectManager.
 *  This is the public, host-path-free view (the `dir` never crosses the wire). */
export type ProjectInfo = { id: string; name: string; createdAt: string }

/** A project scaffold the agent can start from (Phase 15). */
export type TemplateInfo = { id: string; name: string; description: string }

/** A node in the project's file tree (M4). `path` is RELATIVE to the project root — host paths never cross
 *  the wire. Dirs carry `children`; files don't. */
export type FileNode = { name: string; path: string; type: 'file' | 'dir'; children?: FileNode[] }

/** A build/type-check problem (M5.3). `file` is RELATIVE to the project root. */
export type Problem = { file: string; line: number; col: number; message: string }

/** A git checkpoint of the project (M6). `id` is the commit hash. */
export type Version = { id: string; summary: string; createdAt: string }

/** Builder → client. App/workspace-level events, distinct from a session's ActivityEvents.
 *  Future variants (added in their phases) — keep the discriminated union open:
 *    | { type: 'preview';  projectId: string; url: string; status: 'installing' | 'running' | 'error' }
 *    | { type: 'terminal'; projectId: string; data: string }
 *    | { type: 'versions'; projectId: string; versions: { id: string; summary: string; createdAt: string }[] }
 *    | { type: 'files';    projectId: string; tree: ... }
 */
export type BuilderEvent =
  | { type: 'projects'; projects: ProjectInfo[]; activeId?: string } // project sidebar snapshot
  | { type: 'projectCreated'; project: ProjectInfo } // a project was just created (so the Home flow can open it)
  | { type: 'templates'; templates: TemplateInfo[] } // available scaffolds for the create flow (Phase 15)
  | { type: 'files'; tree: FileNode[] } // the active project's file tree (M4)
  | { type: 'fileContent'; path: string; content: string; truncated?: boolean } // a single file's content (M4)
  | { type: 'fileDiff'; path: string; original: string; modified: string } // a file's diff vs last commit (M2; Monaco DiffEditor)
  | { type: 'preview'; status: 'installing' | 'starting' | 'running' | 'error' | 'stopped'; url?: string } // live preview (M3)
  | { type: 'log'; line: string } // a dev-server stdout/stderr line for the Console pane (M5)
  | { type: 'problems'; problems: Problem[]; checking?: boolean } // type-check results for the Problems panel (M5.3)
  | { type: 'versions'; versions: Version[] } // checkpoint history for the Versions panel (M6)
  | { type: 'terminalData'; id: string; data: string } // a chunk of a terminal session's PTY output (M7)
  | { type: 'terminalExit'; id: string } // a terminal session's shell ended (M7)

/** Client → builder. App/workspace-level commands, distinct from a session's InboundMessages.
 *  Future variants (added in their phases): preview start/stop/refresh, terminal input/resize,
 *  version restore/checkout, file read/write, etc. */
export type BuilderCommand =
  | { type: 'project'; action: 'list' | 'create' | 'open' | 'delete'; name?: string; id?: string; templateId?: string }
  | { type: 'files'; action: 'list' } // request the active project's file tree (M4)
  | { type: 'file'; action: 'read' | 'diff'; path: string } // read a file (M4) or get its diff vs last commit (M2)
  | { type: 'preview'; action: 'start' | 'stop' } // start/stop the active project's live preview (M3)
  | { type: 'check' } // run a type-check; results come back as a `problems` event (M5.3)
  | { type: 'versions'; action: 'list' } // request the checkpoint history (M6)
  | { type: 'version'; action: 'restore'; id: string } // restore the project to a checkpoint (M6)
  | { type: 'terminal'; action: 'start' | 'stop'; id: string; cols?: number; rows?: number } // open/close a session (M7)
  | { type: 'terminalInput'; id: string; data: string } // keystrokes → a session's PTY (M7)
  | { type: 'terminalResize'; id: string; cols: number; rows: number } // a session's xterm resized (M7)
