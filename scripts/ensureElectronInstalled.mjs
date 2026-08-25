import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const electronPackageDirectory = dirname(require.resolve('electron/package.json'))
const electronPathFile = join(electronPackageDirectory, 'path.txt')

if (!existsSync(electronPathFile)) {
  const result = spawnSync(process.execPath, [join(electronPackageDirectory, 'install.js')], {
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const electronExecutablePath = require('electron')
if (!existsSync(electronExecutablePath)) {
  throw new Error(`Electron executable is missing after installation: ${electronExecutablePath}`)
}
