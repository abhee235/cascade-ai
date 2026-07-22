// ADR-068 — the live turn is SERVER-owned, not connection-owned. Measured gap: the turn's state lived in the
// WebSocket that started it, so a hard reload (or a second tab) saw an idle-looking project while the agent
// was still building, and the in-flight stream went to a dead socket. These tests pin the reload contract.

import { describe, expect, it } from 'vitest'
import { liveTurn, type TurnNotice } from '../src/liveTurn'

/** Stand-in for a connection: collects what it would have sent, and can "disconnect". */
function connection(viewing?: string) {
	const events: unknown[] = []
	let activity = 0
	const off = liveTurn.subscribe((n: TurnNotice) => {
		if (n.kind === 'activity') activity++
		else if (n.projectId === viewing) events.push(n.ev)
	})
	return { events, off, activityCount: () => activity }
}

describe('liveTurn (server-owned turn state)', () => {
	it('survives the connection that started it — a reload re-attaches to the snapshot', () => {
		const first = connection('p1')
		const turn = liveTurn.start('p1', 'c1')
		liveTurn.publish(turn, { type: 'thinking_delta', thinking: 'weighing ' })
		liveTurn.publish(turn, { type: 'text_delta', text: 'Building the cart' })
		first.off() // the user hits F5 — this socket is gone

		const reloaded = connection('p1')
		const live = liveTurn.for('p1')
		expect(live?.phase).toBe('running')
		expect(live?.chatId).toBe('c1') // the reload lands on the BUILDING chat, not a fresh one
		expect(live?.streamText).toBe('Building the cart') // in-flight stream replayable on re-attach
		expect(live?.streamThinking).toBe('weighing ')

		liveTurn.publish(turn, { type: 'text_delta', text: ' page' }) // the build is still going
		expect(reloaded.events).toEqual([{ type: 'text_delta', text: ' page' }]) // …and the new socket hears it
		liveTurn.end(turn)
		reloaded.off()
	})

	it('a project you are not viewing sends no events, but still reports activity (the sidebar dot)', () => {
		const elsewhere = connection('p2')
		const turn = liveTurn.start('p1', 'c1')
		liveTurn.publish(turn, { type: 'text_delta', text: 'x' })
		expect(elsewhere.events).toEqual([])
		expect(elsewhere.activityCount()).toBe(1) // start
		liveTurn.end(turn)
		expect(elsewhere.activityCount()).toBe(2) // end
		elsewhere.off()
	})

	it('a committed item clears the partial stream (the replay log carries it from here)', () => {
		const turn = liveTurn.start('p1', 'c1')
		liveTurn.publish(turn, { type: 'text_delta', text: 'half a sen' })
		liveTurn.publish(turn, { type: 'status', text: 'thinking' })
		liveTurn.publish(turn, { type: 'message', text: 'half a sentence, finished' })
		const live = liveTurn.for('p1')
		expect(live?.streamText).toBe('')
		expect(live?.status).toBeUndefined()
		liveTurn.end(turn)
	})

	it('a parked approval flips to awaiting and is held for re-attach, then clears when answered', () => {
		const turn = liveTurn.start('p1', 'c1')
		const question = { type: 'question', id: 'q1', questions: [] }
		liveTurn.publish(turn, question)
		expect(liveTurn.for('p1')?.phase).toBe('awaiting')
		expect(liveTurn.for('p1')?.pendingQuestion).toEqual(question) // re-sent on re-attach — still answerable
		liveTurn.publish(turn, { type: 'toolStart', id: 't1', name: 'Write' }) // the loop moved on
		expect(liveTurn.for('p1')?.phase).toBe('running')
		expect(liveTurn.for('p1')?.pendingQuestion).toBeUndefined()
		liveTurn.end(turn)
	})

	it('ending a superseded turn cannot clear its successor', () => {
		const first = liveTurn.start('p1', 'c1')
		const second = liveTurn.start('p2', 'c2')
		liveTurn.end(first) // late `finally` from the turn that was replaced
		expect(liveTurn.for('p2')?.chatId).toBe('c2')
		liveTurn.end(second)
		expect(liveTurn.current).toBeNull()
	})

	it('one closing connection cannot break the fan-out to the others', () => {
		const off = liveTurn.subscribe(() => {
			throw new Error('socket already closed')
		})
		const healthy = connection('p1')
		const turn = liveTurn.start('p1', 'c1')
		liveTurn.publish(turn, { type: 'text_delta', text: 'still delivered' })
		expect(healthy.events).toEqual([{ type: 'text_delta', text: 'still delivered' }])
		liveTurn.end(turn)
		off()
		healthy.off()
	})
})
