// 用途：独立 Node 更新进程；校验 ZIP，等待应用退出，替换程序目录并在失败时回滚。
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const extractZip = require('extract-zip')

const manifestName = 'windows-update-manifest.json'

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest(encoding)
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function validateEntry(name, attributes = 0) {
  const parts = name.replace(/\/$/u, '').split('/')
  if (
    !name ||
    name.includes('\\') ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[<>:"|?*]/u.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    ) ||
    ((attributes >>> 16) & 0o170000) === 0o120000
  ) {
    throw new Error(`Unsafe Windows update entry: ${name}`)
  }
}

async function validateJob(job) {
  if (
    !job ||
    !path.isAbsolute(job.appDir) ||
    !path.isAbsolute(job.userDataDir) ||
    !path.isAbsolute(job.archive) ||
    path.dirname(job.appDir) === job.appDir ||
    path.basename(job.executable) !== job.executable ||
    !job.executable.endsWith('.exe') ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(job.sha512) ||
    !Number.isSafeInteger(job.pid) ||
    job.pid <= 0 ||
    typeof job.appId !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(job.version)
  ) {
    throw new Error('Invalid Windows update job.')
  }
  const appDir = await fs.realpath(job.appDir)
  const userDataDir = await fs.realpath(job.userDataDir)
  if (
    appDir.toLowerCase() !== path.resolve(job.appDir).toLowerCase() ||
    isInside(appDir, userDataDir)
  ) {
    throw new Error(
      'Application directory must be independent of user data and must not be a link.'
    )
  }
  const executable = await fs.lstat(path.join(appDir, job.executable))
  if (!executable.isFile() || executable.isSymbolicLink())
    throw new Error('Installed executable is invalid.')
}

async function readManifest(directory, job) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, manifestName), 'utf8'))
  if (
    manifest.schema !== 1 ||
    manifest.appId !== job.appId ||
    manifest.executable !== job.executable ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    manifest.entries.some((entry) => typeof entry !== 'string' || path.basename(entry) !== entry)
  ) {
    throw new Error('Windows update belongs to a different application.')
  }
  for (const entry of manifest.entries) validateEntry(entry)
  if (
    !(await fs.stat(path.join(directory, job.executable))).isFile() ||
    !(await fs.stat(path.join(directory, 'resources', 'app.asar'))).isFile()
  ) {
    throw new Error('Windows update is missing application files.')
  }
  return manifest
}

async function inventory(directory, prefix = '') {
  const files = []
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Update contains a link: ${name}`)
    if (entry.isDirectory()) files.push(...(await inventory(directory, name)))
    else if (entry.isFile())
      files.push([name, await digest(path.join(directory, name), 'sha256', 'hex')])
    else throw new Error(`Update contains a special file: ${name}`)
  }
  return files.sort(([a], [b]) => a.localeCompare(b))
}

async function prepare(job, helperDir) {
  await validateJob(job)
  if ((await digest(job.archive, 'sha512', 'base64')) !== job.sha512)
    throw new Error('Windows update checksum mismatch.')
  let workRoot
  try {
    workRoot = await fs.mkdtemp(path.join(path.dirname(job.appDir), '.velaros-update-'))
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw new Error('更新目录需要管理员权限。请以管理员身份运行应用后重试。')
    }
    throw error
  }
  const stage = path.join(workRoot, 'next')
  try {
    await fs.mkdir(stage)
    let expandedBytes = 0
    let count = 0
    const names = new Set()
    await extractZip(job.archive, {
      dir: stage,
      onEntry(entry) {
        validateEntry(entry.fileName, entry.externalFileAttributes)
        expandedBytes += entry.uncompressedSize
        count += 1
        const name = entry.fileName.toLowerCase()
        if (
          expandedBytes > 8 * 1024 ** 3 ||
          count > 150_000 ||
          names.has(name) ||
          entry.generalPurposeBitFlag & 1
        ) {
          throw new Error('Invalid or oversized Windows update archive.')
        }
        names.add(name)
      },
    })
    const incoming = await readManifest(stage, job)
    const installed = await readManifest(job.appDir, job)
    if (incoming.version !== job.version) throw new Error('Windows update version mismatch.')
    const files = await inventory(stage)
    const prepared = {
      workRoot,
      files,
      managedEntries: [...new Set([...incoming.entries, ...installed.entries])],
    }
    await fs.writeFile(path.join(helperDir, 'prepared.json'), JSON.stringify(prepared))
    return prepared
  } catch (error) {
    await fs.rm(workRoot, { recursive: true, force: true })
    throw error
  }
}

async function retry(operation, timeout = 30_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code) || Date.now() >= deadline)
        throw error
      await delay(250)
    }
  }
}

function validatePrepared(prepared, job) {
  if (
    !prepared ||
    path.dirname(prepared.workRoot) !== path.dirname(job.appDir) ||
    !/^\.velaros-update-[\w-]+$/u.test(path.basename(prepared.workRoot)) ||
    !Array.isArray(prepared.files) ||
    !Array.isArray(prepared.managedEntries)
  ) {
    throw new Error('Invalid prepared Windows update.')
  }
}

async function replaceApplication(job, prepared, rename = fs.rename) {
  validatePrepared(prepared, job)
  await validateJob(job)
  const stage = path.join(prepared.workRoot, 'next')
  const backup = path.join(prepared.workRoot, 'previous')
  if (JSON.stringify(await inventory(stage)) !== JSON.stringify(prepared.files))
    throw new Error('Prepared Windows update was modified.')
  // NSIS 的卸载程序和用户额外放入的文件不在程序清单中，替换时原样保留。
  const managed = new Set(prepared.managedEntries.map((name) => name.toLowerCase()))
  for (const name of await fs.readdir(job.appDir)) {
    if (!managed.has(name.toLowerCase())) {
      await fs.cp(path.join(job.appDir, name), path.join(stage, name), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      })
    }
  }
  await retry(() => rename(job.appDir, backup))
  try {
    await retry(() => rename(stage, job.appDir))
  } catch (error) {
    await retry(() => fs.rename(backup, job.appDir))
    throw error
  }
  return backup
}

async function waitForExit(pid) {
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      if (error.code !== 'EPERM') throw error
    }
    if (Date.now() >= deadline) throw new Error('Application did not exit; update was not applied.')
    await delay(250)
  }
}

async function launch(job) {
  const child = spawn(
    path.join(job.appDir, job.executable),
    [`--user-data-dir=${job.userDataDir}`],
    {
      cwd: job.appDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }
  )
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

async function run(command, helperDir) {
  const job = JSON.parse(await fs.readFile(path.join(helperDir, 'job.json'), 'utf8'))
  if (command === 'prepare') {
    await prepare(job, helperDir)
    return
  }
  if (command !== 'apply' && command !== 'watch') throw new Error('Unknown Windows update command.')
  job.restart = process.argv[4] === 'restart'
  const prepared = JSON.parse(await fs.readFile(path.join(helperDir, 'prepared.json'), 'utf8'))
  validatePrepared(prepared, job)
  await validateJob(job)
  if (command === 'watch') {
    if (!process.connected) throw new Error('Windows update watcher requires its parent channel.')
    let install = process.argv[4] !== 'skip'
    let cancelled = false
    const disconnected = new Promise((resolve) => process.once('disconnect', resolve))
    process.on('message', (message) => {
      if (message?.cancel === true) {
        cancelled = true
        if (process.connected) process.disconnect()
        return
      }
      if (typeof message?.restart === 'boolean') {
        install = true
        job.restart = message.restart
      }
    })
    process.send({ ready: true })
    // 可以等待任意长的使用时间；父进程退出后才进入有超时的文件释放等待。
    await disconnected
    if (cancelled) {
      await fs.rm(prepared.workRoot, { recursive: true, force: true })
      return
    }
    if (!install) return
  } else {
    process.send?.({ ready: true })
    if (process.connected) process.disconnect()
  }
  const resultPath = path.join(job.userDataDir, 'windows-update-result.json')
  let backup
  let exited = false
  try {
    await waitForExit(job.pid)
    exited = true
    backup = await replaceApplication(job, prepared)
    await fs.writeFile(
      resultPath,
      JSON.stringify({ version: job.version, workRoot: prepared.workRoot, success: true })
    )
    if (job.restart) await launch(job)
  } catch (error) {
    if (backup) {
      await retry(() => fs.rename(job.appDir, path.join(prepared.workRoot, 'failed')))
      await retry(() => fs.rename(backup, job.appDir))
    }
    await fs.writeFile(
      resultPath,
      JSON.stringify({ version: job.version, success: false, error: error.message })
    )
    if (exited && job.restart) await launch(job)
    throw error
  }
}

module.exports = { digest, validateEntry, prepare, replaceApplication, waitForExit, run }
if (require.main === module) {
  run(process.argv[2], process.argv[3]).catch((error) => {
    process.send?.({ error: error.message })
    console.error(error.message)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
