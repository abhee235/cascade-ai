// liveTurn.ts — the ONE turn that may be in flight, owned by the SERVER (ADR-068).
//
// It used to live in the WebSocket connection that started it. That made the turn observable only by that
// socket: a hard reload or a second tab saw an idle-looking project while the agent was still building, and
// the in-flight stream went nowhere. Sessions are owned by ProjectManager, not by a connection — so the live
// state of a turn belongs there too. Connections subscribe and unsubscribe; the turn outlives them.
//
// Holds what the persisted replay log CAN'T: the streaming since the last committed item, and a parked
// approval card (still answerable, because the loop it belongs to is still alive).

export type TurnEvent = { type: string; [k: string]: unknown }
export type TurnPhase = 'running' | 'awaiting'

export interface LiveTurn {
	readonly projectId: string
	readonly chatId: string
	phase: TurnPhase
	streamText: string
	streamThinking: string
	status?: string
	pendingQuestion?: unknown
}

/** What a subscriber hears. `event` goes to whoever is VIEWING that project; `activity` goes to everyone —
 *  the sidebar dot has to render on a project you are not looking at. */
export type TurnNotice = { kind: 'event'; projectId: string; ev: TurnEvent } | { kind: 'activity' }

/** Events that land as a real transcript item — the partial stream they complete is now redundant. */
const COMMITTED = new Set(['message', 'toolStart', 'toolResult', 'memory', 'compacted'])

class LiveTurnRegistry {
	private turn: LiveTurn | null = null
	private listeners = new Set<(n: TurnNotice) => void>()

	/** The turn in flight, whatever project it belongs to (drives the `turnActivity` broadcast). */
	get current(): LiveTurn | null {
		return this.turn
	}

	/** The in-flight turn for one project — what re-attach and chat-loading ask about. */
	for(projectId: string | undefined): LiveTurn | null {
		return projectId && this.turn?.projectId === projectId ? this.turn : null
	}

	subscribe(fn: (n: TurnNotice) => void): () => void {
		this.listeners.add(fn)
		return () => void this.listeners.delete(fn)
	}

	private emit(n: TurnNotice): void {
		for (const fn of [...this.listeners]) {
			try {
				fn(n) // one broken/closing connection must never abort the fan-out to the others
			} catch {
				/* dropped */
			}
		}
	}

	start(projectId: string, chatId: string): LiveTurn {
		this.turn = { projectId, chatId, phase: 'running', streamText: '', streamThinking: '' }
		this.emit({ kind: 'activity' })
		return this.turn
	}

	/** Fold one event into the live snapshot, then fan it out to attached connections. */
	publish(turn: LiveTurn, ev: TurnEvent): void {
		if (this.turn === turn) {
			if (ev.type === 'text_delta') turn.streamText += String(ev.text ?? '')
			else if (ev.type === 'thinking_delta') turn.streamThinking += String(ev.thinking ?? '')
			else if (ev.type === 'status') turn.status = String(ev.text ?? '')
			else if (COMMITTED.has(ev.type)) {
				turn.streamText = '' // the replay log carries it from here
				turn.streamThinking = ''
				turn.status = undefined
			}
			if (ev.type === 'question') {
				turn.phase = 'awaiting'
				turn.pendingQuestion = ev
				this.emit({ kind: 'activity' }) // → amber dot
			} else if (turn.phase === 'awaiting') {
				turn.phase = 'running'
				turn.pendingQuestion = undefined
				this.emit({ kind: 'activity' })
			}
		}
		this.emit({ kind: 'event', projectId: turn.projectId, ev })
	}

	/** End by IDENTITY, so a turn that was already superseded can't clear its successor's state. */
	end(turn: LiveTurn): void {
		if (this.turn !== turn) return
		this.turn = null
		this.emit({ kind: 'activity' })
	}
}

export const liveTurn = new LiveTurnRegistry()
