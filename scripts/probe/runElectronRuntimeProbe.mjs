// 要真的起伪终端的探针。node-pty 在 bun 下收不到数据（bun 对 N-API 模块的事件循环集成不完整），
// 所以先用 bun 把探针打包成 ESM，再用应用自己的 Electron 运行时（ELECTRON_RUN_AS_NODE）跑——
// 这也正是打包后主进程所处的环境。产物放在 build/electron 下，原生模块从仓库 node_modules 解析。
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  OwnedChildProcess,
  unclosedTerminationCommands,
  withinDeadline,
} from '../processLifecycle.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const probeBudgetMilliseconds = 120_000

/**
 * Supervise the real IPC child; admission ACKs never stand in for exit/cleanup receipts.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ deadlineAt: number, signal?: AbortSignal }} options
 */
export async function superviseProbeChild(child, { deadlineAt, signal = undefined }) {
  const resources = new Map()
  const failures = []
  const sends = new Set()
  let finished
  let stopDeadline
  const send = (message) => {
    const delivery = new Promise((resolve, reject) => {
      if (!child.connected) { reject(new Error('Probe IPC disconnected')); return }
      child.send(message, (error) => error ? reject(error) : resolve())
    })
    sends.add(delivery)
    void delivery.then(() => sends.delete(delivery), (error) => {
      sends.delete(delivery)
      failures.push(error)
    })
    return delivery
  }
  const owner = new OwnedChildProcess(child, {
    deadlineAt,
    label: 'Electron runtime probe',
    cooperativeStop: (cleanupDeadline) => {
      stopDeadline = Math.min(stopDeadline ?? deadlineAt, cleanupDeadline)
      return send({ type: 'probe-stop', deadlineAt: stopDeadline })
    },
  })
  const protocolFailure = (message) => {
    failures.push(new Error(message))
    void owner.stop().catch((error) => failures.push(error))
  }
  const onMessage = (message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'probe-ready') {
      void send({ type: stopDeadline ? 'probe-stop' : 'probe-start', deadlineAt: stopDeadline ?? deadlineAt })
    } else if (message.type === 'probe-register') {
      const valid = typeof message.id === 'string' && message.id.length > 0 &&
        (message.kind === 'pty' || message.kind === 'temporary-root') &&
        (message.pid === null || (Number.isSafeInteger(message.pid) && message.pid > 0)) &&
        typeof message.temporaryRoot === 'string' && path.isAbsolute(message.temporaryRoot)
      if (!valid || resources.has(message.id)) {
        protocolFailure('Invalid or duplicate probe resource admission')
        return
      }
      const { id, kind, pid, temporaryRoot } = message
      resources.set(id, { id, kind, pid, temporaryRoot })
      // Record first. A late resource during stop is still our admitted responsibility.
      void send({ type: 'probe-accepted', id }).then(() => {
        if (stopDeadline) void send({ type: 'probe-stop', deadlineAt: stopDeadline })
      }, () => {})
    } else if (message.type === 'probe-release') {
      const resource = resources.get(message.id)
      const exitObserved = resource?.kind !== 'pty' ||
        (message.exit && Number.isSafeInteger(message.exit.exitCode) &&
          (message.exit.signal === undefined || Number.isSafeInteger(message.exit.signal)))
      if (!resource || resource.kind !== message.kind || message.cleanupComplete !== true || !exitObserved) {
        protocolFailure('Probe release lacks its admitted exit/cleanup receipt')
        return
      }
      resources.delete(message.id)
      void send({ type: 'probe-released', id: message.id })
    } else if (message.type === 'probe-finished') {
      if (finished !== undefined || !Number.isSafeInteger(message.exitCode)) {
        protocolFailure('Invalid probe completion receipt')
        return
      }
      finished = message.exitCode
    }
  }
  const onAbort = () => { void owner.stop().catch((error) => failures.push(error)) }
  const onDisconnect = () => {
    if (finished === undefined) protocolFailure('Probe disconnected before its completion receipt')
  }
  child.on('message', onMessage)
  child.on('disconnect', onDisconnect)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    const result = await owner.done
    const deliveries = await Promise.allSettled([...sends].map((delivery) =>
      withinDeadline(delivery, stopDeadline ?? deadlineAt, 'Probe IPC delivery')
    ))
    for (const delivery of deliveries)
      if (delivery.status === 'rejected') failures.push(delivery.reason)
    if (result.error) failures.push(result.error)
    if (result.timedOut || result.stopped || signal?.aborted)
      failures.push(new Error('Runtime probe was interrupted or exceeded its total budget'))
    if (!result.record) failures.push(new Error('Electron ChildProcess close remains unconfirmed'))
    if (finished === undefined) failures.push(new Error('Probe completion receipt is missing'))
    else if (result.record && result.record.code !== finished)
      failures.push(new Error(`Probe completion ${finished} differs from actual close ${result.record.code}`))
    if (resources.size)
      failures.push(new Error(`Probe cleanup receipts missing: ${JSON.stringify([...resources.values()])}`))
    if (unclosedTerminationCommands.size)
      failures.push(new Error(`Termination commands remain unclosed: ${JSON.stringify([...unclosedTerminationCommands.values()])}`))
    if (failures.length) throw new AggregateError(failures, 'Runtime probe owner did not complete')
    return result.record.code ?? 1
  } finally {
    child.off('message', onMessage)
    child.off('disconnect', onDisconnect)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function executeProbe(entry) {
  const deadlineAt = Date.now() + probeBudgetMilliseconds
  const controller = new AbortController()
  let interrupted
  const stop = (signal) => { interrupted ??= signal; controller.abort() }
  const onSigint = () => stop('SIGINT')
  const onSigterm = () => stop('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  const outDir = path.join(repositoryRoot, 'build', 'electron', 'probe')
  const outFile = path.join(outDir, `${path.basename(entry, path.extname(entry))}.mjs`)
  try {
    await withinDeadline(mkdir(outDir, { recursive: true }), deadlineAt, 'Probe output directory')
    controller.signal.throwIfAborted()
    if (Date.now() >= deadlineAt) throw new Error('No probe build budget remains')
    const build = spawn('bun', [
      'build', entry, '--target=node', '--format=esm', '--conditions=source',
      '--external', '@lydell/node-pty', `--outfile=${outFile}`,
    ], { cwd: repositoryRoot, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true })
    const buildOwner = new OwnedChildProcess(build, { deadlineAt, label: 'Probe Bun build' })
    const stopBuild = () => { void buildOwner.stop().catch(console.error) }
    controller.signal.addEventListener('abort', stopBuild, { once: true })
    if (controller.signal.aborted) stopBuild()
    let built
    try { built = await buildOwner.done }
    finally { controller.signal.removeEventListener('abort', stopBuild) }
    if (built.error) throw built.error
    if (built.timedOut || built.stopped || !built.record) throw new Error('Probe build did not close within its budget')
    if (built.record.code !== 0) return built.record.code ?? 1
    controller.signal.throwIfAborted()
    const electronExecutablePath = require('electron')
    const entrypoint = fileURLToPath(new URL('./electronProbeEntrypoint.mjs', import.meta.url))
    if (Date.now() >= deadlineAt) throw new Error('No Electron probe budget remains')
    const child = spawn(electronExecutablePath, [entrypoint, outFile], {
      cwd: repositoryRoot,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VELAROS_PROBE_DEADLINE_AT: String(deadlineAt) },
    })
    return await superviseProbeChild(child, { deadlineAt, signal: controller.signal })
  } catch (error) {
    if (!interrupted) throw error
    console.error(error)
    return interrupted === 'SIGINT' ? 130 : 143
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

/** Build and run the probe under one deadline; delegates keep their existing CLI entrypoint. */
export function runElectronRuntimeProbe(entry) {
  void executeProbe(entry).then(
    (code) => { process.exitCode = code },
    (error) => { console.error(error); process.exitCode = 1 }
  )
}
