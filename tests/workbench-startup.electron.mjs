import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { manualElectronTestArgs } from './helpers/manualElectronTest.mjs'

const [entryPath = 'build/electron/main/index.js'] = manualElectronTestArgs()
if (process.platform !== 'win32') {
  console.info('Skipped Windows startup test on this platform')
  process.exit(0)
}
const require = createRequire(import.meta.url)
const electron = require('electron')
const entry = pathToFileURL(resolve(entryPath)).href
const scratch = await mkdtemp(join(tmpdir(), 'workbench-startup-'))
const project = join(scratch, 'external project')
const closing = join(scratch, 'closing')
const result = join(scratch, 'result.json')
const diagnostics = join(scratch, 'startup.log')
await mkdir(project)
await writeFile(join(scratch, 'package.json'), JSON.stringify({ main: 'main.mjs' }))
await writeFile(
  join(scratch, 'main.mjs'),
  `
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { app } from 'electron'

const closing = ${JSON.stringify(closing)}
const result = ${JSON.stringify(result)}
const diagnostics = ${JSON.stringify(diagnostics)}
const project = ${JSON.stringify(project)}
const restarting = existsSync(closing)
const log = (event) => appendFileSync(diagnostics, process.pid + ' ' + event + '\\n')
let allowQuit = restarting
let quitAttempts = 0
const deadline = setTimeout(() => app.exit(1), 30_000)
process.on('unhandledRejection', (error) => { log(error.stack); app.exit(1) })
app.on('browser-window-created', (_event, window) => {
  log('window created')
  if (!restarting && quitAttempts > 0) return
  const shown = new Promise(resolve => window.once('show', resolve))
  window.webContents.once('did-finish-load', async () => {
    const state = await window.webContents.executeJavaScript(
      'window.velarosWorkbenchProjectHub.getState()'
    )
    log('project state loaded')
    await shown
    if (!window.isVisible()) throw new Error('Workbench window is hidden after showing')
    log('window visible')
    if (restarting) {
      app.once('will-quit', () => {
        writeFileSync(result, JSON.stringify({ path: state.currentProject?.path, pid: process.pid }))
      })
      clearTimeout(deadline)
      app.quit()
    } else if (!state.currentProject) {
      window.close()
    }
  })
})
app.on('before-quit', (event) => {
  quitAttempts += 1
  log('before-quit ' + quitAttempts)
  if (allowQuit || quitAttempts < 2) return
  event.preventDefault()
  if (quitAttempts > 2) return
  // Keep the exiting primary alive after teardown so a real secondary reaches its lock.
  writeFileSync(closing, String(process.pid))
  spawn(process.execPath, [app.getAppPath(), project], { stdio: 'ignore', windowsHide: true })
})
app.on('second-instance', () => {
  log('second-instance')
  if (!restarting && quitAttempts >= 2) {
    allowQuit = true
    clearTimeout(deadline)
    setImmediate(() => app.quit())
  }
})
await import(${JSON.stringify(entry)})
`
)

const primary = spawn(electron, [scratch], {
  cwd: scratch,
  env: {
    ...process.env,
    VELAROS_ANALYTICS_DISABLED: '1',
    VELAROS_SHARED_DATA_ROOT: join(scratch, 'shared'),
  },
  stdio: 'inherit',
})

try {
  const deadline = Date.now() + 45_000
  let relaunched
  while (Date.now() < deadline) {
    try {
      relaunched = JSON.parse(await readFile(result, 'utf8'))
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (primary.exitCode !== null && primary.exitCode !== 0) break
    await delay(50)
  }
  assert.equal(
    relaunched?.path,
    project,
    `The launch during quit must reopen the requested project\n${await readFile(diagnostics, 'utf8').catch(() => '')}`
  )
  assert.notEqual(relaunched.pid, primary.pid, 'The old instance must finish shutting down')
  console.info('Workbench opened once and delivered the launch during quit to a fresh instance')
} finally {
  if (primary.exitCode === null) primary.kill()
  await rm(scratch, { recursive: true, force: true, maxRetries: 10 })
}
