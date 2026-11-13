// 用途：在 Windows 上用真实 Electron 进程验证 ZIP 下载、退出替换与数据保留。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { build } from 'esbuild'
import yaml from 'js-yaml'

const require = createRequire(import.meta.url)
const { createPackage } = require('@electron/asar')
if (process.platform !== 'win32') throw new Error('This probe requires native Windows.')
const [unpackedPath, zipPath, sourcePath] = process.argv.slice(2, 5).map((value) => resolve(value))
const installOnQuit = process.argv[5] === 'on-quit'
if (!sourcePath) throw new Error('Expected unpacked application, update ZIP and updater source.')
const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-update-e2e-中文 ')))
const installed = join(root, 'Application')
const profile = join(root, 'User Data')
const harness = join(root, 'Harness')
const startupLog = join(root, 'startup.log')
const requests = []
const info = JSON.parse(await readFile(join(unpackedPath, 'windows-update-manifest.json'), 'utf8'))
const zipName = basename(zipPath)
async function hash(file, algorithm = 'sha256', encoding = 'hex') {
  const result = createHash(algorithm)
  for await (const bytes of createReadStream(file)) result.update(bytes)
  return result.digest(encoding)
}
const metadata = yaml.dump({
  version: info.version,
  files: [
    { url: 'must-not-download-setup.exe', sha512: Buffer.alloc(64).toString('base64'), size: 1 },
    {
      url: zipName,
      sha512: await hash(zipPath, 'sha512', 'base64'),
      size: (await stat(zipPath)).size,
    },
  ],
})
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  requests.push(pathname)
  if (pathname === '/latest.yml') response.end(metadata)
  else if (pathname === `/${zipName}`) {
    response.setHeader('Content-Length', String(zipSize))
    createReadStream(zipPath).pipe(response)
  } else {
    response.statusCode = 404
    response.end()
  }
})
const zipSize = (await stat(zipPath)).size
server.listen(0, '127.0.0.1')
await once(server, 'listening')
let child
let output = ''
try {
  await cp(unpackedPath, installed, { recursive: true })
  await Promise.all([mkdir(profile), mkdir(harness)])
  await writeFile(join(profile, 'conversations.json'), 'keep my conversation')
  await writeFile(join(installed, 'Uninstall fixture.exe'), 'keep uninstaller')
  await writeFile(join(installed, 'user-note.txt'), 'keep extra file')
  // 旧版夹具使用同版本 Electron 引擎，允许装载测试入口；更新目标始终是原始发行 ZIP。
  await copyFile(require('electron'), join(installed, info.executable))
  await writeFile(
    join(harness, 'package.json'),
    JSON.stringify({ name: 'update-probe', version: '0.0.0', main: 'main.cjs' })
  )
  const configPath = join(root, 'update.yml')
  await writeFile(
    configPath,
    yaml.dump({
      provider: 'generic',
      url: `http://127.0.0.1:${server.address().port}/`,
      updaterCacheDirName: `velaros-probe-${basename(root)}`,
    })
  )
  await writeFile(
    join(harness, 'main.cjs'),
    `const fs = require('node:fs');
     const { app } = require('electron');
     const { format } = require('node:util');
     const log = (...args) => fs.appendFileSync(${JSON.stringify(startupLog)}, format(...args) + String.fromCharCode(10));
     console.log = console.warn = console.error = log;
     process.on('uncaughtException', error => { log(error); app.exit(1); });
     process.on('unhandledRejection', error => { log(error); app.exit(1); });
     log('Windows updater probe started');
     require('./updater.cjs');`
  )
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { app } from 'electron';
        import { WindowsArchiveUpdater } from ${JSON.stringify(sourcePath)};
        app.setPath('userData', ${JSON.stringify(profile)});
        app.whenReady().then(async () => {
          const updater = new WindowsArchiveUpdater(${JSON.stringify({
            appId: info.appId,
            executable: join(installed, info.executable),
            nodeExecutable: join(
              installed,
              'resources/app.asar.unpacked/node_modules/node-win-x64/bin/node.exe'
            ),
            workerFile: join(installed, 'resources/windows-update.cjs'),
            userDataDirectory: profile,
          })});
          updater.on('error', error => { console.error(error); app.exit(1); });
          updater.updateConfigPath = ${JSON.stringify(configPath)};
          updater.setFeedURL(${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)});
          updater.autoDownload = false;
          updater.autoInstallOnAppQuit = ${installOnQuit};
          updater.autoRunAppAfterInstall = false;
          const result = await updater.checkForUpdates();
          if (!result?.isUpdateAvailable) throw Error('Update was not found');
          const files = await updater.downloadUpdate();
          if (!files[0]?.endsWith('.zip')) throw Error('Downloaded Setup instead of ZIP');
          console.log('ZIP downloaded and prepared');
          ${installOnQuit ? 'app.quit();' : 'updater.quitAndInstall(true, false);'}
        }).catch(error => { console.error(error); app.exit(1); });
      `,
    },
    outfile: join(harness, 'updater.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  await rm(join(installed, 'resources/app.asar'))
  await createPackage(harness, join(installed, 'resources/app.asar'))
  child = spawn(join(installed, info.executable), [], {
    cwd: installed,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      output = (output + bytes).slice(-20000)
    })
  const timer = setTimeout(() => child.kill(), 180_000)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)
  output += await readFile(startupLog, 'utf8').catch((error) => `Startup log: ${error.message}`)
  assert.equal(code, 0, output)
  const task = JSON.parse(await readFile(join(profile, 'windows-update-owner.json'), 'utf8'))
  assert.match(task.jobId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu)
  assert.equal(task.appDir, installed)
  assert.equal(task.userDataDir, profile)
  const receipt = join(profile, `windows-update-result-${task.jobId}.json`)
  const deadline = Date.now() + 90_000
  let result
  while (Date.now() < deadline) {
    try {
      result = JSON.parse(await readFile(receipt, 'utf8'))
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(300)
  }
  assert.equal(result?.success, true, JSON.stringify(result) + output)
  assert.equal(result.jobId, task.jobId)
  assert.equal(result.workerExited, true)
  assert.equal(result.cancelled, false)
  assert.equal(result.version, info.version)
  assert.equal(
    await hash(join(installed, info.executable)),
    await hash(join(unpackedPath, info.executable))
  )
  assert.equal(
    await hash(join(installed, 'resources/app.asar')),
    await hash(join(unpackedPath, 'resources/app.asar'))
  )
  assert.equal(await readFile(join(profile, 'conversations.json'), 'utf8'), 'keep my conversation')
  assert.equal(await readFile(join(installed, 'Uninstall fixture.exe'), 'utf8'), 'keep uninstaller')
  assert.equal(await readFile(join(installed, 'user-note.txt'), 'utf8'), 'keep extra file')
  assert.ok(requests.includes('/latest.yml'))
  assert.ok(requests.includes(`/${zipName}`))
  assert.ok(!requests.some((name) => name.endsWith('.exe')))
  console.log(
    JSON.stringify({
      product: info.appId,
      version: info.version,
      zipDownload: true,
      executableReplaced: true,
      resourcesReplaced: true,
      profilePreserved: true,
      setupRequests: 0,
      installOnQuit,
    })
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  if (child && child.exitCode === null) child.kill()
  server.closeAllConnections()
  server.close()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
