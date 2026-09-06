#!/usr/bin/env node
// Run the API worker and the Vite dev server together, prefixing output.
// Stops both on Ctrl+C. Configure via .env / LINESCOUT_* variables.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const python = join(root, 'services/api/.venv/bin/python')
if (!existsSync(python)) {
  console.error('API virtualenv missing. Run `npm run setup:py` first.')
  process.exit(1)
}

const env = { ...process.env }

const children = [
  ['api', python, ['-m', 'linescout_api.main'], join(root, 'services/api')],
  ['web', 'npm', ['run', 'dev', '--workspace=@drawable/web'], root],
].map(([name, cmd, args, cwd]) => {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = `[${name}] `
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, tag)))
  }
  child.on('exit', (code) => {
    console.log(`${tag}exited with ${code}`)
    shutdown(code ?? 0)
  })
  return child
})

function shutdown(code = 0) {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 200)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
