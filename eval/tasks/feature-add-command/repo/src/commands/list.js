// list — return a copy of the current list.
module.exports = {
	name: 'list',
	run(state) {
		return state.slice()
	},
}
