// add — append an item to the list (returns a NEW array; state is never mutated).
module.exports = {
	name: 'add',
	run(state, item) {
		return [...state, item]
	},
}
