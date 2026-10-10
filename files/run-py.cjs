// Runs a Python script with the first interpreter found on PATH:
// python3, python, then py (Windows launcher).
const { execFileSync } = require('child_process')

const [, , script, ...args] = process.argv
for (const bin of ['python3', 'python', 'py']) {
	try {
		execFileSync(bin, [script, ...args], { stdio: 'inherit' })
		process.exit(0)
	} catch (err) {
		if (err && err.code !== 'ENOENT') process.exit(err.status ?? 1)
	}
}
console.error('No Python interpreter found (tried python3, python, py).')
process.exit(1)
