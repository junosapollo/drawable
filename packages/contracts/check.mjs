import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const root = import.meta.dirname
const tmpFile = path.join(os.tmpdir(), 'drawable-openapi-check.d.ts')
execSync(`npx openapi-typescript openapi.json -o "${tmpFile}"`, { cwd: root, stdio: 'inherit' })
const expected = fs.readFileSync(path.join(root, 'generated.ts'), 'utf8')
const actual = fs.readFileSync(tmpFile, 'utf8')

const normalize = (s) => s.replace(/\r\n/g, '\n')
if (normalize(expected) !== normalize(actual)) {
  process.stderr.write('generated.ts is out of sync with openapi.json. Run npm run generate.\n')
  process.exit(1)
} else {
  process.stdout.write('Contracts are in sync with openapi.json.\n')
}
