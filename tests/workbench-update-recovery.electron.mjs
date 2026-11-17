// Native Electron regression: fs/promises traverses .asar as a virtual directory.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import asar from '@electron/asar'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-update-recovery-'))
try {
  const appDir = path.join(root, 'Installed App')
  const userDataDir = path.join(root, 'User Data')
  const jobId = randomUUID()
  const helperDirectory = path.join(root, `velaros-update-helper-${jobId}`)
  const workRoot = path.join(root, `.velaros-update-${jobId}`)
  const input = path.join(root, 'archive-input')
  await Promise.all(
    [appDir, userDataDir, helperDirectory, input, path.join(workRoot, 'previous/resources')].map(
      (directory) => fs.mkdir(directory, { recursive: true })
    )
  )
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      fs.writeFile(path.join(input, `${i}.js`), 'export const value = 1')
    )
  )
  await asar.createPackage(input, path.join(workRoot, 'previous/resources/app.asar'))
  const task = {
    schema: 1,
    jobId,
    appId: 'com.velaros.fixture',
    appDir,
    executable: 'Example App.exe',
    userDataDir,
    helperDirectory,
    workRoot,
    archive: path.join(root, 'update.zip'),
    version: '1.0.1',
    sha512: Buffer.alloc(64).toString('base64'),
    pid: process.pid,
    restart: false,
  }
  await fs.writeFile(path.join(userDataDir, 'windows-update-owner.json'), JSON.stringify(task))
  await fs.writeFile(
    path.join(userDataDir, `windows-update-result-${jobId}.json`),
    JSON.stringify({ ...task, success: true, cancelled: false, workerExited: true })
  )
  await fs.writeFile(path.join(userDataDir, 'keep.json'), 'keep user data')
  await fs.writeFile(path.join(appDir, 'Example App.exe'), 'keep installed app')
  const main = path.join(root, 'main.mjs')
  await build({
    stdin: {
      contents: `
      import { app } from 'electron'
      import { readFileSync } from 'node:fs'
      import { WindowsArchiveUpdater } from './src/main/updates/WindowsArchiveUpdater.ts'
      app.setPath('userData', ${JSON.stringify(userDataDir)})
      app.whenReady().then(async () => {
      if (process.env.LOCK_PREVIOUS_ARCHIVE === '1') readFileSync(${JSON.stringify(path.join(workRoot, 'previous/resources/app.asar/0.js'))})
      const updater = new WindowsArchiveUpdater(${JSON.stringify({ appId: task.appId, executable: path.join(appDir, task.executable), nodeExecutable: process.execPath, workerFile: '', userDataDirectory: userDataDir })})
      updater.on('error', error => { console.error(error); app.exit(1) })
      await updater.recovery
      console.info('PASS native ASAR recovery cleanup')
      app.exit(0)
      }).catch(error => { console.error(error); app.exit(1) })
    `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    outfile: main,
    platform: 'node',
    format: 'esm',
    bundle: true,
    external: ['electron'],
    plugins: [
      {
        name: 'update-host',
        setup(builder) {
          builder.onResolve({ filter: /^electron-updater(\/|$)/ }, (args) => ({
            path: args.path,
            namespace: 'update-host',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'update-host' }, (args) => ({
            contents:
              args.path === 'electron-updater'
                ? `import { EventEmitter } from 'node:events';import {createRequire} from 'node:module';const {SemVer}=createRequire(${JSON.stringify(import.meta.url)})('semver');export class AppUpdater extends EventEmitter {app = {version:'1.0.2'};currentVersion=new SemVer(this.app.version); dispatchError(error){this.emit('error',error)} }`
                : 'export class ElectronHttpExecutor {}',
            loader: 'js',
          }))
        },
      },
    ],
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const attempt of process.platform === 'win32' ? [0, 1] : [1]) {
    env.LOCK_PREVIOUS_ARCHIVE = attempt === 0 ? '1' : '0'
    const child = spawn(require('electron'), [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (bytes) => {
      output += bytes.toString()
    })
    child.stderr.on('data', (bytes) => {
      output += bytes.toString()
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }).finally(() => clearTimeout(timeout))
    assert.equal(code, 0, output)
    if (attempt === 0) {
      await assert.rejects(fs.stat(path.join(userDataDir, 'windows-update-owner.json')), {
        code: 'ENOENT',
      })
      assert.equal(
        (await fs.stat(path.join(userDataDir, `windows-update-cleanup-${jobId}.json`))).isFile(),
        true
      )
      console.info('PASS locked completed backup releases the active update slot')
      continue
    }
    for (const target of [
      workRoot,
      helperDirectory,
      path.join(userDataDir, 'windows-update-owner.json'),
      path.join(userDataDir, `windows-update-result-${jobId}.json`),
    ])
      await assert.rejects(fs.stat(target), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(userDataDir, 'keep.json'), 'utf8'), 'keep user data')
    assert.equal(
      await fs.readFile(path.join(appDir, 'Example App.exe'), 'utf8'),
      'keep installed app'
    )
    console.info(output.trim())
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
