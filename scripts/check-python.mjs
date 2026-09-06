#!/usr/bin/env node
// Cross-platform equivalent of scripts/check-python.sh.
//
// Lints, type-checks, and tests both Python packages (ml, services/api) the
// same way CI does. Uses scripts/run-python.mjs under the hood so the
// virtualenv interpreter is found regardless of the host OS.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const VENV_PY = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'

function venvPy(pkg) {
  return resolve(root, pkg, '.venv', VENV_PY)
}

function run(cmd, args, options = {}) {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...options })
    child.on('error', rejectFn)
    child.on('exit', (code) => {
      if (code === 0) resolveFn(undefined)
      else rejectFn(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

async function checkPackage(pkg, module) {
  const py = venvPy(pkg)
  if (!existsSync(py)) {
    throw new Error(`Missing virtualenv for ${pkg}. Run \`npm run setup:py\` first.`)
  }
  console.log(`\n==> ${pkg}: ruff`)
  await run(py, ['-m', 'ruff', 'check', '.'])
  await run(py, ['-m', 'ruff', 'format', '--check', '.'])
  console.log(`==> ${pkg}: mypy`)
  await run(py, ['-m', 'mypy', module])
  console.log(`==> ${pkg}: pytest`)
  await run(py, ['-m', 'pytest', '-q'])
}

async function main() {
  await checkPackage('ml', 'linescout_ml')
  await checkPackage('services/api', 'linescout_api')
  console.log('\n==> scripts: ruff')
  const apiPy = venvPy('services/api')
  if (!existsSync(apiPy)) {
    throw new Error(`Missing virtualenv for services/api. Run \`npm run setup:py\` first.`)
  }
  await run(
    apiPy,
    ['-m', 'ruff', 'check', '--config', 'services/api/pyproject.toml', 'scripts/'],
    { cwd: root },
  )
  console.log('\nAll Python checks passed.')
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
