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
    job.schema !== 1 ||
    typeof job.jobId !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(job.jobId) ||
    !path.isAbsolute(job.helperDirectory) ||
    path.basename(job.helperDirectory) !== `velaros-update-helper-${job.jobId}` ||
    job.workRoot !== path.join(path.dirname(job.appDir), `.velaros-update-${job.jobId}`) ||
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
  const helperDirectory = await fs.realpath(job.helperDirectory)
  const workRoot = await fs.realpath(job.workRoot)
  if (
    appDir.toLowerCase() !== path.resolve(job.appDir).toLowerCase() ||
    helperDirectory.toLowerCase() !== path.resolve(job.helperDirectory).toLowerCase() ||
    workRoot.toLowerCase() !== path.resolve(job.workRoot).toLowerCase() ||
    isInside(appDir, userDataDir) ||
    isInside(appDir, helperDirectory) ||
    isInside(helperDirectory, appDir) ||
    isInside(helperDirectory, userDataDir) ||
    isInside(workRoot, appDir) ||
    isInside(workRoot, userDataDir)
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
  const workRoot = job.workRoot
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
      jobId: job.jobId,
      workRoot,
      files,
      managedEntries: [...new Set([...incoming.entries, ...installed.entries])],
    }
    await fs.writeFile(path.join(helperDir, 'prepared.json'), JSON.stringify(prepared))
    return prepared
  } catch (error) {
    try {
      await fs.rm(stage, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${error.message}; staging cleanup failed: ${cleanupError.message}`)
    }
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
    prepared.jobId !== job.jobId ||
    prepared.workRoot !== job.workRoot ||
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
    try {
      await retry(() => fs.rename(backup, job.appDir))
    } catch (rollbackError) {
      const failure = new AggregateError([error, rollbackError], `${error.message}; rollback failed: ${rollbackError.message}`)
      failure.rollbackFailed = true
      throw failure
    }
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

const completionScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$helper = [IO.Path]::GetFullPath($env:VELAROS_UPDATE_HELPER)
$workerPid = [int]$env:VELAROS_UPDATE_WORKER_PID
$readyPath = Join-Path $helper ('observer-ready-' + $env:VELAROS_UPDATE_JOB + '.json')
$errorPath = Join-Path $helper ('observer-error-' + $env:VELAROS_UPDATE_JOB + '.json')
$stopPath = Join-Path $helper ('observer-stop-' + $env:VELAROS_UPDATE_JOB + '.json')
$stoppedPath = Join-Path $helper ('observer-stopped-' + $env:VELAROS_UPDATE_JOB + '.json')
$phase = 'identity'
try {
$job = [IO.File]::ReadAllText((Join-Path $helper 'job.json')) | ConvertFrom-Json
if ($job.schema -ne 1 -or $job.jobId -cne $env:VELAROS_UPDATE_JOB -or
    -not [String]::Equals($helper, [IO.Path]::GetFullPath($job.helperDirectory), [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($helper) -cne ('velaros-update-helper-' + $job.jobId)) {
  throw 'Windows update helper identity does not match its task.'
}
$ownerPath = Join-Path $job.userDataDir 'windows-update-owner.json'
function Assert-TaskOwner($owner, $task) {
  foreach ($field in @('jobId', 'helperDirectory', 'workRoot', 'appId', 'appDir', 'executable', 'userDataDir', 'version')) {
    if ($owner.$field -cne $task.$field) { throw 'Windows update task ownership changed.' }
  }
}
Assert-TaskOwner ([IO.File]::ReadAllText($ownerPath) | ConvertFrom-Json) $job
$phase = 'worker-handle'
$worker = [Diagnostics.Process]::GetProcessById($workerPid)
$stopping = $false
try {
  $null = $worker.Handle
  $expectedExecutable = Join-Path $helper 'node.exe'
  if (-not [String]::Equals([IO.Path]::GetFullPath($worker.MainModule.FileName),
      [IO.Path]::GetFullPath($expectedExecutable), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Windows update worker executable does not match its helper.'
  }
  if ($worker.HasExited) { throw 'Windows update worker exited before the ready handshake.' }
  $ready = [ordered]@{ jobId = $job.jobId; workerPid = $workerPid }
  [IO.File]::WriteAllText($readyPath + '.tmp', ($ready | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($readyPath + '.tmp', $readyPath)
  $phase = 'wait-worker'
  # Timed waits use the same held process handle, never a PID-liveness query.
  while (-not $worker.WaitForExit(100)) {
    if ([IO.File]::Exists($stopPath)) {
      $stop = [IO.File]::ReadAllText($stopPath) | ConvertFrom-Json
      if ($stop.jobId -cne $job.jobId -or $stop.workerPid -ne $workerPid) {
        throw 'Windows update observer stop request does not own its task.'
      }
      $stopping = $true
      break
    }
  }
} finally { $worker.Dispose() }
if ($stopping) {
  $phase = 'stop-receipt'
  $stopped = [ordered]@{ jobId = $job.jobId; workerPid = $workerPid; stopped = $true }
  [IO.File]::WriteAllText($stoppedPath + '.tmp', ($stopped | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($stoppedPath + '.tmp', $stoppedPath)
  exit 0
}
$phase = 'terminal-receipt'
$terminal = [IO.File]::ReadAllText((Join-Path $helper 'terminal.json')) | ConvertFrom-Json
$job = [IO.File]::ReadAllText((Join-Path $helper 'job.json')) | ConvertFrom-Json
Assert-TaskOwner ([IO.File]::ReadAllText($ownerPath) | ConvertFrom-Json) $job
if ($terminal.jobId -cne $env:VELAROS_UPDATE_JOB -or $job.jobId -cne $env:VELAROS_UPDATE_JOB -or
    $terminal.success -isnot [bool] -or $terminal.cancelled -isnot [bool] -or
    $terminal.restartAllowed -isnot [bool]) {
  throw 'Windows update completion no longer owns its task.'
}
$receipt = [ordered]@{
  schema = 1
  jobId = $job.jobId
  helperDirectory = $job.helperDirectory
  workRoot = $job.workRoot
  version = $job.version
  workerExited = $true
  success = $terminal.success
  cancelled = $terminal.cancelled
  error = $terminal.error
}
$resultPath = Join-Path $job.userDataDir ('windows-update-result-' + $job.jobId + '.json')
$temporaryPath = $resultPath + '.tmp'
[IO.File]::WriteAllText($temporaryPath, ($receipt | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
[IO.File]::Move($temporaryPath, $resultPath)
if ($job.restart -and $terminal.restartAllowed) {
  $phase = 'restart'
  $arguments = '--user-data-dir="' + $job.userDataDir + '"'
  Start-Process -FilePath (Join-Path $job.appDir $job.executable) -WorkingDirectory $job.appDir -ArgumentList $arguments -WindowStyle Normal
}
} catch {
  $failure = [ordered]@{
    jobId = $env:VELAROS_UPDATE_JOB
    workerPid = $workerPid
    phase = $phase
    error = $_.Exception.ToString()
  }
  try {
    [IO.File]::WriteAllText($errorPath + '.tmp', ($failure | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($errorPath + '.tmp', $errorPath)
  } catch { exit 2 }
  exit 1
}
`

async function startCompletionObserver(job) {
  if (!process.env.SystemRoot || !path.isAbsolute(process.env.SystemRoot))
    throw new Error('Windows update completion requires Windows PowerShell.')
  const readyPath = path.join(job.helperDirectory, `observer-ready-${job.jobId}.json`)
  const errorPath = path.join(job.helperDirectory, `observer-error-${job.jobId}.json`)
  const stopPath = path.join(job.helperDirectory, `observer-stop-${job.jobId}.json`)
  const stoppedPath = path.join(job.helperDirectory, `observer-stopped-${job.jobId}.json`)
  const scriptPath = path.join(job.helperDirectory, 'completion.ps1')
  await fs.writeFile(scriptPath, completionScript)
  const observer = spawn(
    path.join(process.env.SystemRoot, 'System32', 'conhost.exe'),
    ['--headless', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      cwd: job.userDataDir,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        VELAROS_UPDATE_HELPER: job.helperDirectory,
        VELAROS_UPDATE_JOB: job.jobId,
        VELAROS_UPDATE_WORKER_PID: String(process.pid),
      },
    }
  )
  let didClose = false
  const closed = new Promise((resolve) => observer.once('close', (code) => {
    didClose = true
    resolve(code)
  }))
  const processFailed = new Promise((_resolve, reject) => {
    observer.once('error', reject)
  })
  const readFailure = async () => {
    let failure
    try {
      failure = JSON.parse(await fs.readFile(errorPath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (failure.jobId !== job.jobId || failure.workerPid !== process.pid || typeof failure.error !== 'string')
      throw new Error('Windows update observer diagnostic does not own its task.')
    return new Error(`Windows update observer failed (${failure.phase}): ${failure.error}`)
  }
  const controller = new AbortController()
  const ready = async () => {
    for (;;) {
      controller.signal.throwIfAborted()
      const failure = await readFailure()
      if (failure) throw failure
      try {
        const receipt = JSON.parse(await fs.readFile(readyPath, { encoding: 'utf8', signal: controller.signal }))
        if (receipt.jobId !== job.jobId || receipt.workerPid !== process.pid)
          throw new Error('Windows update observer readiness does not own its task.')
        if (didClose || observer.exitCode !== null || observer.signalCode !== null) {
          const failure = await readFailure()
          throw failure ?? new Error('Windows update observer exited before readiness was accepted.')
        }
        return
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await delay(50, undefined, { signal: controller.signal })
    }
  }
  let deadline
  try {
    await Promise.race([
      ready(),
      processFailed,
      closed.then(async (code) => {
        const failure = await readFailure()
        throw failure ?? new Error(`Windows update completion observer did not become ready (${code}); diagnostic: ${errorPath}`)
      }),
      new Promise((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Windows update completion observer startup timed out.')), 30_000)
      }),
    ])
  } catch (error) {
    if (observer.exitCode === null && observer.signalCode === null) observer.kill()
    await closed
    throw error
  } finally {
    controller.abort()
    clearTimeout(deadline)
  }
  observer.unref()
  return {
    closed,
    async stop() {
      observer.ref()
      if (observer.exitCode === null && observer.signalCode === null) {
        const temporaryPath = `${stopPath}.tmp`
        await fs.writeFile(temporaryPath, JSON.stringify({ jobId: job.jobId, workerPid: process.pid }))
        await fs.rename(temporaryPath, stopPath)
      }
      const code = await closed
      const failure = await readFailure()
      if (failure || code !== 0)
        throw failure ?? new Error(`Windows update observer stop failed (${code}).`)
      const receipt = JSON.parse(await fs.readFile(stoppedPath, 'utf8'))
      if (receipt.jobId !== job.jobId || receipt.workerPid !== process.pid || receipt.stopped !== true)
        throw new Error('Windows update observer stop receipt does not own its task.')
    },
  }
}

async function run(command, helperDir) {
  const job = JSON.parse(await fs.readFile(path.join(helperDir, 'job.json'), 'utf8'))
  if (path.resolve(helperDir) !== job.helperDirectory)
    throw new Error('Windows update helper does not own its task.')
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
    const observer = await startCompletionObserver(job)
    if (process.connected) process.send({ ready: true })
    // 可以等待任意长的使用时间；父进程退出后才进入有超时的文件释放等待。
    await Promise.race([
      disconnected,
      observer.closed.then(() => { throw new Error('Windows update completion observer stopped before installation.') }),
    ])
    if (cancelled) {
      await observer.stop()
      return
    }
    if (!install) {
      await fs.writeFile(path.join(helperDir, 'terminal.json'), JSON.stringify({
        jobId: job.jobId, success: false, cancelled: true, error: '', restartAllowed: false,
      }))
      return
    }
  } else {
    await startCompletionObserver(job)
    if (process.connected) process.send({ ready: true })
    if (process.connected) process.disconnect()
  }
  let backup
  let exited = false
  let terminal
  let failure
  try {
    await waitForExit(job.pid)
    exited = true
    backup = await replaceApplication(job, prepared)
    terminal = { success: true, cancelled: false, error: '', restartAllowed: true }
  } catch (error) {
    failure = error
    if (backup) {
      try {
        await retry(() => fs.rename(job.appDir, path.join(prepared.workRoot, 'failed')))
        await retry(() => fs.rename(backup, job.appDir))
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError], `${error.message}; rollback failed: ${rollbackError.message}`)
        failure.rollbackFailed = true
      }
    }
    terminal = {
      success: false, cancelled: false, error: failure.message,
      restartAllowed: exited && !failure.rollbackFailed,
    }
  }
  try {
    await fs.writeFile(path.join(helperDir, 'job.json'), JSON.stringify(job))
    await fs.writeFile(path.join(helperDir, 'terminal.json'), JSON.stringify({ jobId: job.jobId, ...terminal }))
  } catch (recordError) {
    if (failure)
      throw new AggregateError([failure, recordError], `${failure.message}; completion recording failed: ${recordError.message}`)
    throw recordError
  }
  if (failure) throw failure
}

module.exports = { digest, validateEntry, prepare, replaceApplication, waitForExit, run }
if (require.main === module) {
  run(process.argv[2], process.argv[3]).catch((error) => {
    if (process.connected) process.send({ error: error.message })
    console.error(error.message)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
