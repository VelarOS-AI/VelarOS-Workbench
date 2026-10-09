import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
  const helper = join(root, 'Helper')
  await Promise.all([
    mkdir(join(appDir, 'resources'), { recursive: true }),
    mkdir(userDataDir),
    mkdir(helper),
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
    appDir,
    userDataDir,
    archive,
    sha512: await digest(archive, 'sha512', 'base64'),
    appId: manifest.appId,
    executable: manifest.executable,
    version: '1.0.1',
    pid: process.pid,
  }
  return { root, job, helper }
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
  await assert.rejects(readFile(join(job.appDir, 'obsolete.dll')), {
    code: 'ENOENT',
  })
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
})

test(
  'detached updater waits for its parent to exit before applying an update',
  { timeout: 30_000 },
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
    const script = join(helper, 'worker.cjs')
    await build({
      entryPoints: [workerPath],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    })
    const runtime = join(helper, process.platform === 'win32' ? 'node.exe' : 'node')
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
    const result = JSON.parse(
      await readFile(join(job.userDataDir, 'windows-update-result.json'), 'utf8')
    )
    assert.equal(result.success, true)
    assert.equal(dirname(result.workRoot), dirname(job.appDir))
  }
)
