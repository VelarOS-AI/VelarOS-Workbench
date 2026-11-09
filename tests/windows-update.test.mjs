import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const workerPath = resolve('resources/updates/windows-update.cjs')
const { digest, prepare, replaceApplication, validateEntry } = require(workerPath)

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-update-中文 spaces-')))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
  const appDir = join(root, 'Installed App')
  const userDataDir = join(root, 'User Data')
  const jobId = randomUUID()
  const helper = join(root, `velaros-update-helper-${jobId}`)
  const workRoot = join(root, `.velaros-update-${jobId}`)
  await Promise.all([
    mkdir(join(appDir, 'resources'), { recursive: true }),
    mkdir(userDataDir),
    mkdir(helper),
    mkdir(workRoot),
  ])
  const manifest = {
    schema: 1,
    appId: 'com.velaros.fixture',
    version: '1.0.0',
    executable: 'Example App.exe',
    entries: ['Example App.exe', 'resources', 'obsolete.dll', 'windows-update-manifest.json'],
  }
  await Promise.all([
    writeFile(join(appDir, 'Example App.exe'), 'old exe'),
    writeFile(join(appDir, 'resources/app.asar'), 'old asar'),
    writeFile(join(appDir, 'obsolete.dll'), 'old dll'),
    writeFile(join(appDir, 'Uninstall Example App.exe'), 'uninstaller'),
    writeFile(join(appDir, 'user-note.txt'), 'keep this'),
    writeFile(join(appDir, 'windows-update-manifest.json'), JSON.stringify(manifest)),
    writeFile(join(userDataDir, 'conversations.json'), 'my conversations'),
  ])
  const zip = new JSZip()
  zip.file('Example App.exe', 'new exe')
  zip.file('resources/app.asar', 'new asar')
  zip.file(
    'windows-update-manifest.json',
    JSON.stringify({
      ...manifest,
      version: '1.0.1',
      entries: manifest.entries.filter((name) => name !== 'obsolete.dll'),
      ...overrides,
    })
  )
  const archive = join(root, 'update.zip')
  await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }))
  const job = {
    schema: 1,
    jobId,
    helperDirectory: helper,
    workRoot,
    appDir,
    userDataDir,
    archive,
    sha512: await digest(archive, 'sha512', 'base64'),
    appId: manifest.appId,
    executable: manifest.executable,
    version: '1.0.1',
    pid: process.pid,
    restart: false,
  }
  return { root, job, helper }
}

async function readReceipt(job) {
  const resultPath = join(job.userDataDir, `windows-update-result-${job.jobId}.json`)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultPath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await delay(50)
    }
  }
  let diagnostic = ''
  try {
    diagnostic = await readFile(join(job.helperDirectory, `observer-error-${job.jobId}.json`), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const facts = await Promise.allSettled([
    readFile(join(job.helperDirectory, 'terminal.json'), 'utf8'),
    readFile(join(job.helperDirectory, `observer-ready-${job.jobId}.json`), 'utf8'),
    readFile(join(dirname(job.appDir), 'worker-exits.jsonl'), 'utf8'),
  ])
  throw new Error(`Windows update completion receipt was not published. ${diagnostic} ${JSON.stringify(facts)}`)
}

test('archive update replaces Electron files while preserving user data, uninstaller and extra files', async (t) => {
  const { job, helper } = await fixture(t)
  const prepared = await prepare(job, helper)
  await replaceApplication(job, prepared)
  assert.equal(await readFile(join(job.appDir, job.executable), 'utf8'), 'new exe')
  assert.equal(await readFile(join(job.appDir, 'resources/app.asar'), 'utf8'), 'new asar')
  assert.equal(await readFile(join(job.appDir, 'Uninstall Example App.exe'), 'utf8'), 'uninstaller')
  assert.equal(await readFile(join(job.appDir, 'user-note.txt'), 'utf8'), 'keep this')
  assert.equal(
    await readFile(join(job.userDataDir, 'conversations.json'), 'utf8'),
    'my conversations'
  )
  await assert.rejects(readFile(join(job.appDir, 'obsolete.dll')), { code: 'ENOENT' })
})

test('failed directory switch rolls the old application back', async (t) => {
  const { job, helper } = await fixture(t)
  const prepared = await prepare(job, helper)
  const { rename } = await import('node:fs/promises')
  await assert.rejects(
    replaceApplication(job, prepared, async (source, target) => {
      if (source.endsWith('next')) throw Object.assign(new Error('Disk failure'), { code: 'EIO' })
      await rename(source, target)
    }),
    /Disk failure/u
  )
  assert.equal(await readFile(join(job.appDir, job.executable), 'utf8'), 'old exe')
  assert.equal(await readFile(join(job.appDir, 'resources/app.asar'), 'utf8'), 'old asar')
})

test('a failed rollback preserves the install error and the previous files', async (t) => {
  const { root, job, helper } = await fixture(t)
  const prepared = await prepare(job, helper)
  const { rename } = await import('node:fs/promises')
  const retained = join(root, 'retained-previous')
  const installError = new Error('Directory switch failed')
  await assert.rejects(
    replaceApplication(job, prepared, async (source, target) => {
      if (source.endsWith('next')) {
        await rename(join(prepared.workRoot, 'previous'), retained)
        throw installError
      }
      await rename(source, target)
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.strictEqual(error.errors[0], installError)
      assert.equal(error.errors[1].code, 'ENOENT')
      assert.equal(error.rollbackFailed, true)
      return true
    }
  )
  assert.equal(await readFile(join(retained, job.executable), 'utf8'), 'old exe')
  assert.equal(await readFile(join(job.userDataDir, 'conversations.json'), 'utf8'), 'my conversations')
})

test('rejects corrupt archives, wrong product, wrong version, and modified staging', async (t) => {
  const first = await fixture(t)
  await assert.rejects(
    prepare({ ...first.job, sha512: Buffer.alloc(64).toString('base64') }, first.helper),
    /checksum/u
  )
  const wrong = await fixture(t, { appId: 'another.product' })
  await assert.rejects(prepare(wrong.job, wrong.helper), /different application/u)
  const version = await fixture(t, { version: '9.0.0' })
  await assert.rejects(prepare(version.job, version.helper), /version mismatch/u)
  const prepared = await prepare(first.job, first.helper)
  await writeFile(join(prepared.workRoot, 'next/resources/app.asar'), 'changed')
  await assert.rejects(replaceApplication(first.job, prepared), /modified/u)
  assert.equal(await readFile(join(first.job.appDir, first.job.executable), 'utf8'), 'old exe')
})

test('rejects traversal, Windows aliases, links and application-local user data', async (t) => {
  for (const name of [
    '../escape',
    '/absolute',
    'C:/escape',
    'one\\two',
    'NUL.txt',
    'con',
    'file:stream',
    'file.',
    'file ',
  ])
    assert.throws(() => validateEntry(name))
  assert.throws(() => validateEntry('link', 0o120777 << 16))
  const { job, helper } = await fixture(t)
  await assert.rejects(prepare({ ...job, userDataDir: job.appDir }, helper), /independent/u)
  const nestedUserData = join(job.workRoot, 'user-data')
  await mkdir(nestedUserData)
  await assert.rejects(prepare({ ...job, userDataDir: nestedUserData }, helper), /independent/u)
})

// The native handoff uses a real Windows Process handle; ZIP and rollback checks above stay portable.
test(
  'detached updater waits for its parent to exit before applying an update',
  { timeout: 30_000, skip: process.platform !== 'win32' },
  async (t) => {
    const { job, helper } = await fixture(t)
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    t.after(() => {
      if (parent.exitCode === null) parent.kill()
    })
    await once(parent, 'spawn')
    job.pid = parent.pid
    await prepare(job, helper)
    await writeFile(join(helper, 'job.json'), JSON.stringify(job))
    await writeFile(join(job.userDataDir, 'windows-update-owner.json'), JSON.stringify(job))
    const script = join(helper, 'worker.cjs')
    await build({
      entryPoints: [workerPath],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    })
    const runtime = join(helper, 'node.exe')
    await copyFile(process.execPath, runtime)
    const worker = spawn(runtime, [script, 'apply', helper, 'exit'], {
      cwd: helper,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let error = ''
    worker.stderr.on('data', (data) => {
      error += data.toString()
    })
    t.after(() => {
      if (worker.exitCode === null) worker.kill()
    })
    const completed = once(worker, 'exit')
    const [message] = await once(worker, 'message')
    assert.equal(message.ready, true)
    await delay(100)
    assert.equal(await readFile(join(job.appDir, job.executable), 'utf8'), 'old exe')
    parent.kill()
    const [code] = await completed
    assert.equal(code, 0, error)
    assert.equal(await readFile(join(job.appDir, job.executable), 'utf8'), 'new exe')
    const result = await readReceipt(job)
    assert.equal(result.success, true)
    assert.equal(result.workerExited, true)
    assert.equal(result.jobId, job.jobId)
    assert.equal(dirname(result.workRoot), dirname(job.appDir))
  }
)

for (const action of ['close', 'install', 'replace', 'cancel']) {
  test(
    action === 'cancel'
      ? 'prepared Windows updater cancels only after its worker exits'
      : `prepared Windows updater applies on ${action} without another download`,
    { timeout: 30_000, skip: process.platform !== 'win32' },
    async (t) => {
      const { root, job } = await fixture(t)
      const bundledWorker = join(root, 'worker.cjs')
      await build({
        entryPoints: [workerPath],
        outfile: bundledWorker,
        bundle: true,
        platform: 'node',
        format: 'cjs',
      })
      const exitLedger = join(root, 'worker-exits.jsonl')
      const observedWorker = join(root, 'observed-worker.cjs')
      await writeFile(observedWorker, `
        const { appendFileSync, existsSync } = require('node:fs')
        process.once('exit', () => appendFileSync(process.env.UPDATE_EXIT_LEDGER, JSON.stringify({
          command: process.argv[2], directory: process.argv[3], pid: process.pid,
          directoryExists: existsSync(process.argv[3]),
        }) + '\\n'))
        require(${JSON.stringify(bundledWorker)}).run(process.argv[2], process.argv[3]).catch((error) => {
          if (process.connected) process.send({ error: error.message })
          console.error(error.message)
          process.exitCode = 1
          if (process.connected) process.disconnect()
        })
      `)
      const parentFile = join(root, 'parent.mjs')
      await build({
        stdin: {
          contents: `
          import { readFile } from 'node:fs/promises'
          import { join } from 'node:path'
          import { WindowsArchiveUpdater } from './src/main/updates/WindowsArchiveUpdater.ts'
          const options = JSON.parse(process.env.UPDATE_OPTIONS)
          const updater = new WindowsArchiveUpdater(options)
          updater.autoInstallOnAppQuit = true
          updater.autoRunAppAfterInstall = false
          updater.on('error', (error) => { console.error(error); process.exit(1) })
          await updater.recovery
          if (process.env.UPDATE_ACTION === 'recover') {
            process.send({ recovered: true })
            process.disconnect()
          } else {
          const downloadOptions = { updateInfoAndProvider: {
            info: { version: '1.0.1' },
            provider: { resolveFiles: () => [{ url: new URL('https://updates.test/update.zip'), info: { sha512: process.env.UPDATE_SHA512 } }] }
          } }
          await updater.doDownloadUpdate(downloadOptions)
          let task = JSON.parse(await readFile(join(options.userDataDirectory, 'windows-update-owner.json'), 'utf8'))
          let previousTask
          if (process.env.UPDATE_ACTION === 'replace') {
            previousTask = task
            await updater.doDownloadUpdate(downloadOptions)
            task = JSON.parse(await readFile(join(options.userDataDirectory, 'windows-update-owner.json'), 'utf8'))
          }
          if (process.env.UPDATE_ACTION === 'cancel') await updater.cancelPreparedUpdate()
          process.send({ downloaded: true, task, previousTask })
          process.once('message', (action) => {
            if (action === 'install') updater.quitAndInstall(true, false)
            else process.exit(0)
          })
          }
        `,
          resolveDir: process.cwd(),
          loader: 'ts',
        },
        outfile: parentFile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        plugins: [
          {
            name: 'update-app-host',
            setup(builder) {
              builder.onResolve({ filter: /^electron-updater(\/|$)/ }, (args) => ({
                path: args.path,
                namespace: 'update-host',
              }))
              builder.onLoad({ filter: /.*/, namespace: 'update-host' }, (args) => ({
                contents:
                  args.path === 'electron-updater'
                    ? `
              import { EventEmitter } from 'node:events'
              export class AppUpdater extends EventEmitter {
                app = { version: process.env.UPDATE_VERSION || '1.0.0', quit: () => process.exit(0), onQuit: (handler) => process.on('exit', () => handler(0)) }
                async executeDownload(options) { await options.done({ downloadedFile: process.env.UPDATE_ARCHIVE }); return [] }
                dispatchUpdateDownloaded(event) { this.emit('update-downloaded', event) }
                dispatchError(error) { this.emit('error', error) }
              }
            `
                    : 'export class ElectronHttpExecutor {}',
                loader: 'js',
              }))
            },
          },
        ],
      })
      const startParent = (nextAction, version = '1.0.0') => spawn(process.execPath, [parentFile], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          UPDATE_ACTION: nextAction,
          UPDATE_VERSION: version,
          UPDATE_EXIT_LEDGER: exitLedger,
          UPDATE_ARCHIVE: job.archive,
          UPDATE_SHA512: job.sha512,
          UPDATE_OPTIONS: JSON.stringify({
            appId: job.appId,
            executable: join(job.appDir, job.executable),
            nodeExecutable: process.execPath,
            workerFile: observedWorker,
            userDataDirectory: job.userDataDir,
          }),
        },
      })
      const parent = startParent(action)
      let error = ''
      parent.stderr.on('data', (bytes) => {
        error += bytes.toString()
      })
      t.after(() => {
        if (parent.exitCode === null) parent.kill()
      })
      const exited = once(parent, 'exit')
      const downloaded = await Promise.race([
        once(parent, 'message').then(([message]) => message),
        exited.then(([code]) => {
          throw new Error(`Updater parent exited early (${code}): ${error}`)
        }),
      ])
      assert.equal(downloaded.downloaded, true)
      const task = downloaded.task
      const ledger = (await readFile(exitLedger, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      const retired = action === 'replace' ? downloaded.previousTask : action === 'cancel' ? task : null
      if (retired) {
        const closedWorker = ledger.find((entry) => entry.command === 'watch' && entry.directory === retired.helperDirectory)
        assert.equal(closedWorker?.directoryExists, true, 'helper exists until its runtime exits')
        await assert.rejects(readFile(join(retired.helperDirectory, 'job.json')), { code: 'ENOENT' })
        await assert.rejects(readdir(retired.workRoot), { code: 'ENOENT' })
      }
      if (action !== 'cancel')
        assert.equal(JSON.parse(await readFile(join(task.helperDirectory, 'job.json'), 'utf8')).jobId, task.jobId)
      assert.equal(await readFile(join(job.appDir, job.executable), 'utf8'), 'old exe')
      parent.send(action)
      const [code] = await exited
      assert.equal(code, 0, error)
      if (action === 'cancel') {
        await assert.rejects(readFile(join(job.userDataDir, 'windows-update-owner.json')), { code: 'ENOENT' })
        assert.equal(await readFile(join(job.appDir, job.executable), 'utf8'), 'old exe')
        return
      }
      const result = await readReceipt(task)
      assert.equal(result?.success, true, JSON.stringify(result))
      assert.equal(result.workerExited, true)
      assert.equal(result.jobId, task.jobId)
      assert.equal(result.helperDirectory, task.helperDirectory)
      assert.equal(result.workRoot, task.workRoot)
      assert.equal(await readFile(join(job.appDir, job.executable), 'utf8'), 'new exe')
      assert.equal(
        await readFile(join(job.userDataDir, 'conversations.json'), 'utf8'),
        'my conversations'
      )
      const untouched = join(root, `velaros-update-helper-${randomUUID()}`)
      await mkdir(untouched)
      await writeFile(join(untouched, 'sentinel'), 'preserve')
      if (action === 'close') {
        const resultPath = join(job.userDataDir, `windows-update-result-${task.jobId}.json`)
        await writeFile(resultPath, JSON.stringify({ ...result, jobId: randomUUID() }))
        const rejected = startParent('recover', '1.0.1')
        rejected.stderr.resume()
        assert.equal((await once(rejected, 'exit'))[0], 1)
        assert.equal(JSON.parse(await readFile(join(task.helperDirectory, 'job.json'), 'utf8')).jobId, task.jobId)
        assert.equal(await readFile(join(task.workRoot, 'previous', job.executable), 'utf8'), 'old exe')
        await writeFile(resultPath, JSON.stringify(result))
      }
      const successor = startParent('recover', '1.0.1')
      let recoveryError = ''
      successor.stderr.on('data', (bytes) => { recoveryError += bytes.toString() })
      assert.equal((await once(successor, 'exit'))[0], 0, recoveryError)
      await assert.rejects(readFile(join(task.helperDirectory, 'job.json')), { code: 'ENOENT' })
      await assert.rejects(readdir(task.workRoot), { code: 'ENOENT' })
      await assert.rejects(readFile(join(job.userDataDir, 'windows-update-owner.json')), { code: 'ENOENT' })
      await assert.rejects(readFile(join(job.userDataDir, `windows-update-result-${task.jobId}.json`)), { code: 'ENOENT' })
      assert.equal(await readFile(join(untouched, 'sentinel'), 'utf8'), 'preserve')
    }
  )
}
