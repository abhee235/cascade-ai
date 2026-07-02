// registry.js — command lookup. Every command module exports { name, run(state, arg) }.
const add = require('./commands/add.js')
const list = require('./commands/list.js')

const commands = new Map([
	[add.name, add],
	[list.name, list],
])

function run(name, state, arg) {
	const cmd = commands.get(name)
	if (!cmd) throw new Error(`unknown command: ${name}`)
	return cmd.run(state, arg)
}

module.exports = { run, commands }
