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

/** Builder → client. App/workspace-level events, distinct from a session's ActivityEvents.
 *  Future variants (added in their phases) — keep the discriminated union open:
 *    | { type: 'preview';  projectId: string; url: string; status: 'installing' | 'running' | 'error' }
 *    | { type: 'terminal'; projectId: string; data: string }
 *    | { type: 'versions'; projectId: string; versions: { id: string; summary: string; createdAt: string }[] }
 *    | { type: 'files';    projectId: string; tree: ... }
 */
export type BuilderEvent =
  | { type: 'projects'; projects: ProjectInfo[]; activeId?: string } // project sidebar snapshot
  | { type: 'templates'; templates: TemplateInfo[] } // available scaffolds for the create flow (Phase 15)
  | { type: 'files'; tree: FileNode[] } // the active project's file tree (M4)
  | { type: 'fileContent'; path: string; content: string; truncated?: boolean } // a single file's content (M4)

/** Client → builder. App/workspace-level commands, distinct from a session's InboundMessages.
 *  Future variants (added in their phases): preview start/stop/refresh, terminal input/resize,
 *  version restore/checkout, file read/write, etc. */
export type BuilderCommand =
  | { type: 'project'; action: 'list' | 'create' | 'open' | 'delete'; name?: string; id?: string; templateId?: string }
  | { type: 'files'; action: 'list' } // request the active project's file tree (M4)
  | { type: 'file'; action: 'read'; path: string } // request a single file's content (M4)
