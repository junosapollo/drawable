#!/usr/bin/env node
// Locate the Python executable in a virtualenv and run a module/script with args.
//
// Usage (intended to be called from npm scripts):
//   node scripts/run-python.mjs <venv-relative-path> <module-or-script> [args...]
//
// Examples:
//   node scripts/run-python.mjs services/api/.venv -m linescout_api.main
//   node scripts/run-python.mjs ml/.venv scripts/export_openapi.py
//
// Why this exists:
//   npm scripts on Windows can't use POSIX paths like `.venv/bin/python`, and
//   shelling out to `bash` requires Git Bash / WSL on stock Windows. This
//   runner resolves the correct interpreter for the host OS, then spawns it
//   directly with `child_process.spawn`, so npm scripts work identically on
//   Windows, macOS, and Linux.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function pythonPath(venvDir) {
  const absolute = isAbsolute(venvDir) ? venvDir : resolve(root, venvDir)
  // POSIX: .venv/bin/python(.exe is a no-op on POSIX; node tolerates the suffix).
  // Windows: .venv/Scripts/python.exe.
  const candidates = process.platform === 'win32'
    ? [join(absolute, 'Scripts', 'python.exe'), join(absolute, 'Scripts', 'python')]
    : [join(absolute, 'bin', 'python3'), join(absolute, 'bin', 'python')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const [, , venvArg, moduleOrScript, ...rest] = process.argv
if (!venvArg || !moduleOrScript) {
  console.error('usage: node scripts/run-python.mjs <venv-dir> <module-or-script> [args...]')
  process.exit(2)
}

const python = pythonPath(venvArg)
if (!python) {
  console.error(
    `Python interpreter not found in '${venvArg}'. Run \`npm run setup:py\` first.`,
  )
  process.exit(1)
}

const isModule = moduleOrScript === '-m' || moduleOrScript === '-c'
const args = isModule ? [moduleOrScript, ...rest] : [moduleOrScript, ...rest]

const child = spawn(python, args, {
  stdio: 'inherit',
  // Inherit the parent's env so .env values and LINESCOUT_* overrides flow through.
  env: process.env,
})

child.on('error', (error) => {
  console.error(`failed to start ${python}: ${error.message}`)
  process.exit(1)
})

// Forward the child's exit status so npm run surfaces failures correctly.
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`python process terminated by signal ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 0)
})
