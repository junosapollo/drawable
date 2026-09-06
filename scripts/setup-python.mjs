#!/usr/bin/env node
// Cross-platform equivalent of scripts/setup-python.sh.
//
// Creates ml/.venv and services/api/.venv, installs uv if missing, and
// syncs each workspace's `[dev]` extras. Identical behaviour on Windows,
// macOS, and Linux; the only dependency is a working Python 3.11.
//
// The original `.sh` script remains in the repo for reference and for
// environments that already have bash, but `npm run setup:py` now routes
// here so the rest of the npm workflow is OS-agnostic.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const VENV_PY_CANDIDATES = process.platform === 'win32'
  ? ['Scripts/python.exe', 'Scripts/python']
  : ['bin/python3', 'bin/python']

const WORKSPACES = [
  { name: 'ml', packageDir: 'ml' },
  { name: 'services/api', packageDir: 'services/api' },
]

function run(cmd, args, options = {}) {
  const child = spawn(cmd, args, { stdio: 'inherit', ...options })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf-8' })
}

function venvPython(workspace) {
  for (const suffix of VENV_PY_CANDIDATES) {
    const candidate = join(workspace, '.venv', suffix)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function findSystemPython() {
  // `python3` first (POSIX default, Windows Python launcher), then `python`.
  // We just need *any* working interpreter to bootstrap uv; uv then creates
  // the actual .venv with the requested version.
  for (const candidate of ['python3', 'python']) {
    const result = runCapture(candidate, ['--version'])
    if (result.status === 0) return candidate
  }
  return null
}

async function ensureUv() {
  const which = runCapture(process.platform === 'win32' ? 'where' : 'which', ['uv'])
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0]

  console.log('uv not found; installing via pip...')
  const py = findSystemPython()
  if (!py) {
    throw new Error(
      'No Python interpreter found. Install Python 3.11 and re-run `npm run setup:py`.',
    )
  }
  await run(py, ['-m', 'pip', 'install', '--user', 'uv'])
  // After a user install, uv typically lands in %APPDATA%\Python\Scripts on
  // Windows or ~/.local/bin on POSIX. Re-check; if still missing, instruct.
  const after = runCapture(process.platform === 'win32' ? 'where' : 'which', ['uv'])
  if (after.status !== 0 || !after.stdout.trim()) {
    throw new Error(
      'uv was installed but is not on PATH. Restart the shell or add it to PATH, then re-run.',
    )
  }
  return after.stdout.trim().split(/\r?\n/)[0]
}

async function setupWorkspace(uv, workspace) {
  console.log(`\n==> ${workspace.name}`)
  const packageAbs = resolve(root, workspace.packageDir)
  const venvDir = join(packageAbs, '.venv')
  if (!venvPython(workspace.packageDir)) {
    await run(uv, ['venv', '--python', '3.11', venvDir, '--quiet'], { cwd: packageAbs })
  } else {
    console.log('    .venv already exists; skipping venv creation')
  }
  // ``uv pip install`` needs the Python interpreter's venv directory, not
  // the path to the ``python3`` symlink — passing the symlink confuses
  // recent uv releases. Point ``--python`` at the resolved binary instead
  // and run from the package directory so the editable install finds the
  // ``pyproject.toml``.
  const py = venvPython(workspace.packageDir)
  if (!py) {
    throw new Error(`failed to locate python in ${workspace.packageDir}/.venv`)
  }
  await run(uv, ['pip', 'install', '--python', py, '--quiet', '-e', '.[dev]'], {
    cwd: packageAbs,
  })
}

async function main() {
  const uv = await ensureUv()
  for (const workspace of WORKSPACES) {
    await setupWorkspace(uv, workspace)
  }
  console.log('\nDone. Next:')
  console.log('  npm run dev:all        # API + web together')
  console.log('  npm run check:py       # ruff + mypy + pytest for both packages')
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
