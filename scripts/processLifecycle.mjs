import { spawn } from 'node:child_process'

const terminationReserveMilliseconds = 5_500
const forceKillDelayMilliseconds = 1_500
const finalCloseReserveMilliseconds = 1_000

// Entries leave this table only on the command's actual close event.
export const unclosedTerminationCommands = new Map()

export function withinDeadline(promise, deadlineAt, label = 'Process cleanup') {
  let timer
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} deadline exceeded`)),
      Math.max(0, deadlineAt - Date.now())
    )
  })
  return Promise.race([promise, expired]).then((value) => {
    if (Date.now() > deadlineAt) throw new Error(`${label} deadline exceeded`)
    return value
  }).finally(() => clearTimeout(timer))
}

function observeClose(child) {
  let record
  let failure
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { failure = error })
    child.once('close', (code, signal) => {
      record = { code, signal, error: failure }
      resolve(record)
    })
  })
  return { closed, get record() { return record } }
}

/** Release event-loop references only after reporting an unconfirmed cleanup failure. */
function unrefUnclosedProcess(child) {
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
  if (child.connected) child.disconnect()
  child.unref()
}

function ownedGroupAlive(child) {
  if (!child.pid || process.platform === 'win32') return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForOwnedGroupExit(child, deadlineAt) {
  while (ownedGroupAlive(child))
    await withinDeadline(new Promise((resolve) => setTimeout(resolve, 25)), deadlineAt)
}

/** Signal only a directly held child/group; taskkill is itself a bounded, observed child. */
async function terminateProcessTree(child, signal, deadlineAt) {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw new Error(`No termination budget remains for PID ${pid}`)
    const closeReserve = Math.min(finalCloseReserveMilliseconds, Math.floor(remaining / 2))
    const command = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const observation = observeClose(command)
    unclosedTerminationCommands.set(command, { pid: command.pid, targetPid: pid })
    void observation.closed.then(() => unclosedTerminationCommands.delete(command))
    try {
      const result = await withinDeadline(
        observation.closed,
        deadlineAt - closeReserve,
        `taskkill for PID ${pid}`
      )
      if (result.error || result.code !== 0)
        throw result.error ?? new Error(`taskkill failed (${result.code}) for PID ${pid}`)
    } catch (error) {
      if (!observation.record) {
        let killError
        try { command.kill('SIGKILL') } catch (failure) { killError = failure }
        try {
          await withinDeadline(observation.closed, deadlineAt, `taskkill close for PID ${pid}`)
        } catch (closeError) {
          unrefUnclosedProcess(command)
          throw new AggregateError([error, ...(killError ? [killError] : []), closeError], `Unconfirmed taskkill close for PID ${pid}`)
        }
        if (killError) throw new AggregateError([error, killError], `Failed to stop taskkill for PID ${pid}`)
      }
      throw error
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
    // A closed root may already have a reused PID; never fall back to that bare number.
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
}

/** Own one real ChildProcess through close, including bounded interruption and escalation. */
export class OwnedChildProcess {
  /**
   * @param {import('node:child_process').ChildProcess} child
   * @param {{ deadlineAt: number, label: string, cooperativeStop?: (deadlineAt: number) => Promise<unknown> }} options
   */
  constructor(child, { deadlineAt, label, cooperativeStop = undefined }) {
    this.child = child
    this.deadlineAt = deadlineAt
    this.label = label
    this.cooperativeStop = cooperativeStop
    this.observation = observeClose(child)
    this.closed = this.observation.closed
    this.timedOut = false
    this.stopStarted = new Promise((resolve) => { this.resolveStopStarted = resolve })
    this.done = this.monitor()
  }

  get record() { return this.observation.record }

  stop(signal = 'SIGTERM') {
    if (!this.stopping) {
      // Publish the promise before any callback can report a synchronous close.
      this.stopping = Promise.resolve().then(() => this.stopOwned(signal))
      void this.stopping.catch(() => {}) // monitor awaits the same failure below.
      this.resolveStopStarted()
    }
    return this.stopping
  }

  async stopOwned(signal) {
    const deadlineAt = Math.min(this.deadlineAt, Date.now() + terminationReserveMilliseconds)
    const remaining = Math.max(0, deadlineAt - Date.now())
    const forceAt = deadlineAt - Math.min(finalCloseReserveMilliseconds, Math.floor(remaining / 2))
    const errors = []
    let force
    const escalation = setTimeout(() => {
      force = Promise.resolve().then(() => {
        if (this.record && !ownedGroupAlive(this.child)) return
        return terminateProcessTree(this.child, 'SIGKILL', deadlineAt)
      })
      void force.catch(() => {})
    }, Math.max(0, (this.cooperativeStop ? forceAt : Math.min(forceAt, Date.now() + forceKillDelayMilliseconds)) - Date.now()))
    try {
      try {
        if (this.cooperativeStop)
          await withinDeadline(this.cooperativeStop(forceAt), forceAt, `${this.label} stop delivery`)
        else await terminateProcessTree(this.child, signal, forceAt)
      } catch (error) { errors.push(error) }
      try {
        await withinDeadline(this.closed, deadlineAt, `${this.label} close`)
        await waitForOwnedGroupExit(this.child, deadlineAt)
      } catch (error) { errors.push(error) }
      if (force) {
        try { await force } catch (error) { errors.push(error) }
      }
    } finally {
      clearTimeout(escalation)
      if (!this.record) unrefUnclosedProcess(this.child)
    }
    if (errors.length) throw new AggregateError(errors, `Failed to close ${this.label} (PID ${this.child.pid ?? 'unknown'})`)
  }

  async monitor() {
    let timeout
    let error
    const remaining = Math.max(0, this.deadlineAt - Date.now())
    const reserve = Math.min(terminationReserveMilliseconds, Math.floor(remaining / 2))
    const expired = new Promise((resolve) => {
      timeout = setTimeout(() => {
        this.timedOut = true
        resolve()
      }, remaining - reserve)
    })
    try {
      await Promise.race([this.closed, this.stopStarted, expired])
      if (this.stopping) await this.stopping
      else if (this.timedOut || ownedGroupAlive(this.child)) await this.stop()
    } catch (failure) { error = failure }
    finally { clearTimeout(timeout) }
    if (Date.now() > this.deadlineAt) this.timedOut = true
    return {
      record: this.record,
      timedOut: this.timedOut,
      stopped: !!this.stopping,
      error: error ?? this.record?.error,
    }
  }
}
