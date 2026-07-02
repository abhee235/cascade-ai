// remove — drop the FIRST occurrence of an item (returns a NEW array; state is never mutated).
module.exports = {
	name: 'remove',
	run(state, item) {
		const idx = state.indexOf(item)
		if (idx === -1) return state.slice()
		return [...state.slice(0, idx), ...state.slice(idx + 1)]
	},
}
