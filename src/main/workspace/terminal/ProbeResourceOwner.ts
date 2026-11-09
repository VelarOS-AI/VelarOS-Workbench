import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'

import {
  nodePtyFactory,
  type WorkbenchPtyExit,
  type WorkbenchPtyFactory,
} from './WorkbenchPty'

interface ProbeResource {
  id: string
  kind: 'pty' | 'temporary-root'
  pid: number | null
  temporaryRoot: string
  accepted: Promise<void>
  exited?: Promise<WorkbenchPtyExit>
  exit?: WorkbenchPtyExit
  disposeExit?: () => void
}

interface Acknowledgement {
  resolve: () => void
  reject: (error: Error) => void
}

/** Internal probe owner: real PTY exits and cleanup receipts, never PID-liveness guesses. */
export class ProbeResourceOwner {
  private readonly controller = new AbortController()
  public readonly signal = this.controller.signal
  private readonly resources = new Map<string, ProbeResource>()
  private readonly acknowledgements = new Map<string, Acknowledgement>()
  private readonly failures = new Set<unknown>()
  private readonly cleanupJobs = new Set<Promise<unknown>>()
  private readonly forcePlans = new Map<readonly number[], ReturnType<typeof Promise.withResolvers<void>>>()
  private readonly expired = Promise.withResolvers<never>()
  private deadlineAt: number
  private deadlineTimer: NodeJS.Timeout
  private deadlineExpired = false
  private root?: ProbeResource
  private cleanup?: () => Promise<void>
  private closing?: Promise<void>

  public readonly ptyFactory: WorkbenchPtyFactory = {
    readCwd: nodePtyFactory.readCwd,
    processTree: {
      list: (pid) => this.trackWork(Promise.resolve().then(() => nodePtyFactory.processTree.list(pid))),
      signal: (pids, signal) => {
        // TerminalSessions always schedules an independent force call after SIGTERM.
        // onExit does not cancel it. Register before delegating, not when its timer fires.
        if (signal === 'SIGTERM') {
          const force = Promise.withResolvers<void>()
          void force.promise.catch(() => {}) // close awaits this same result.
          this.forcePlans.set(pids, force)
        }
        const work = this.trackWork(Promise.resolve().then(() => nodePtyFactory.processTree.signal(pids, signal)))
        void work.then(
          () => {
            if (signal === 'SIGKILL') {
              this.forcePlans.get(pids)?.resolve()
              this.forcePlans.delete(pids)
            }
          },
          (error: unknown) => {
            if (signal === 'SIGKILL') {
              this.forcePlans.get(pids)?.reject(error)
              this.forcePlans.delete(pids)
            }
          }
        )
        return work
      },
    },
    spawn: (file, args, options) => {
      this.signal.throwIfAborted()
      if (this.closing || !this.root) throw new Error('Probe PTY has no live temporary-root owner')
      const pty = nodePtyFactory.spawn(file, args, options)
      const resource = this.claim('pty', pty.pid > 0 ? pty.pid : null, this.root.temporaryRoot)
      const exited = Promise.withResolvers<WorkbenchPtyExit>()
      resource.exited = exited.promise
      const subscription = pty.onExit((event) => {
        resource.exit = event
        exited.resolve(event)
      })
      resource.disposeExit = () => subscription.dispose()
      return {
        ...pty,
        kill: (signal) => {
          try { pty.kill(signal) }
          catch (error) { this.failures.add(error); throw error }
        },
      }
    },
  }

  public constructor() {
    const deadlineAt = Number(process.env.VELAROS_PROBE_DEADLINE_AT)
    if (!process.send || !process.connected || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)
      throw new Error('Runtime probe requires its parent IPC owner and deadline')
    this.deadlineAt = deadlineAt
    this.deadlineTimer = this.armDeadline()
    void this.expired.promise.catch(() => {})
    process.on('message', this.onMessage)
    process.on('disconnect', this.onDisconnect)
  }

  public async connect(): Promise<void> {
    await this.exchange('ready', { type: 'probe-ready' })
    this.signal.throwIfAborted()
  }

  public setCleanup(cleanup: () => Promise<void>): void {
    this.cleanup = cleanup
    if (this.signal.aborted) this.startCleanup()
  }

  public async registerTemporaryRoot(temporaryRoot: string): Promise<void> {
    if (this.root) throw new Error('Probe already owns a temporary root')
    this.root = this.claim('temporary-root', process.pid, temporaryRoot)
    await this.admitted()
  }

  public async admitted(): Promise<void> {
    await this.withBudget(
      Promise.all([...this.resources.values()].map((resource) => resource.accepted)),
      'Probe resource admission'
    )
    this.signal.throwIfAborted()
  }

  public close(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.closeOwnedResources())
    return this.closing
  }

  private claim(kind: ProbeResource['kind'], pid: number | null, temporaryRoot: string): ProbeResource {
    const id = randomUUID()
    // Sending starts in a microtask, after the local owner is in the ledger.
    const accepted = Promise.resolve().then(() =>
      this.exchange(`accepted:${id}`, { type: 'probe-register', id, kind, pid, temporaryRoot })
    )
    const resource: ProbeResource = { id, kind, pid, temporaryRoot, accepted }
    this.resources.set(id, resource)
    void accepted.catch((error: unknown) => {
      this.failures.add(error)
      this.requestStop(error)
    })
    return resource
  }

  private async closeOwnedResources(): Promise<void> {
    try {
      if (this.cleanup) {
        try { await this.withBudget(this.cleanup(), 'Probe service cleanup') }
        catch (error) { this.failures.add(error) }
      }
      const resources = [...this.resources.values()]
      // A concurrent stop may still be awaiting list(). Its later SIGTERM/force must
      // join this drain too; one snapshot of currently running signals is insufficient.
      while (this.cleanupJobs.size || this.forcePlans.size) {
        await this.collectFailures([
          ...this.cleanupJobs,
          ...[...this.forcePlans.values()].map((force) => force.promise),
        ])
        if (this.deadlineExpired) break
      }
      await this.collectFailures([
        ...resources.map((resource) => resource.accepted),
        ...resources.flatMap((resource) => resource.exited ? [resource.exited] : []),
      ])
      if (this.failures.size)
        throw new AggregateError([...this.failures], `Probe cleanup incomplete: ${this.describeResources()}`)
      if (this.deadlineExpired || Date.now() >= this.deadlineAt)
        throw new Error(`Probe cleanup deadline exceeded: ${this.describeResources()}`)

      // A successful service close can time out internally: require actual onExit too.
      for (const resource of resources) {
        if (resource.kind === 'pty') {
          if (!resource.exit) throw new Error(`No PTY onExit receipt for ${resource.id}`)
          await this.release(resource, resource.exit)
        }
      }
      if (this.root) {
        await this.withBudget(rm(this.root.temporaryRoot, { recursive: true, force: true }), 'Probe temporary-root cleanup')
        await this.release(this.root)
      }
    } catch (error) {
      console.error('[WorkbenchProbe] cleanup remains unconfirmed', this.describeResources())
      throw error
    } finally {
      clearTimeout(this.deadlineTimer)
      process.off('message', this.onMessage)
      process.off('disconnect', this.onDisconnect)
      for (const resource of this.resources.values()) resource.disposeExit?.()
    }
  }

  private async release(resource: ProbeResource, exit?: WorkbenchPtyExit): Promise<void> {
    await this.exchange(`released:${resource.id}`, {
      type: 'probe-release',
      id: resource.id,
      kind: resource.kind,
      exit,
      cleanupComplete: true,
    })
    resource.disposeExit?.()
    this.resources.delete(resource.id)
  }

  private describeResources(): string {
    return JSON.stringify([...this.resources.values()].map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      pid: resource.pid,
      temporaryRoot: resource.temporaryRoot,
      exitObserved: !!resource.exit,
    })))
  }

  private armDeadline(): NodeJS.Timeout {
    return setTimeout(() => {
      this.deadlineExpired = true
      const error = new Error('Probe cleanup deadline exceeded')
      this.expired.reject(error)
      this.requestStop(error)
    }, Math.max(0, this.deadlineAt - Date.now()))
  }

  private trackWork<T>(work: Promise<T>): Promise<T> {
    this.cleanupJobs.add(work)
    void work.then(
      () => this.cleanupJobs.delete(work),
      (error: unknown) => {
        this.cleanupJobs.delete(work)
        this.failures.add(error)
      }
    )
    return work
  }

  private async collectFailures(work: Array<Promise<unknown>>): Promise<void> {
    const results = await Promise.allSettled(work.map((promise) =>
      this.withBudget(promise, 'Probe PTY exit and signal cleanup')
    ))
    for (const result of results)
      if (result.status === 'rejected') this.failures.add(result.reason)
  }

  private async withBudget<T>(promise: Promise<T>, label: string): Promise<T> {
    try {
      const value = await Promise.race([promise, this.expired.promise])
      if (this.deadlineExpired || Date.now() > this.deadlineAt) throw new Error('Probe deadline exceeded')
      return value
    }
    catch (error) { throw new Error(label, { cause: error }) }
  }

  private async exchange(key: string, message: object): Promise<void> {
    const acknowledgement = Promise.withResolvers<void>()
    this.acknowledgements.set(key, acknowledgement)
    try {
      await this.withBudget(Promise.all([this.send(message), acknowledgement.promise]), `Probe ${key} acknowledgement`)
    } finally {
      this.acknowledgements.delete(key)
    }
  }

  private send(message: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!process.send || !process.connected) {
        reject(new Error('Probe parent disconnected'))
        return
      }
      process.send(message, (error) => error ? reject(error) : resolve())
    })
  }

  private requestStop(reason: unknown): void {
    if (!this.signal.aborted) this.controller.abort(reason)
    this.startCleanup()
  }

  private startCleanup(): void {
    if (this.cleanup)
      void this.close().catch((error: unknown) => console.error('[WorkbenchProbe] stop cleanup failed', error))
  }

  private readonly onDisconnect = (): void => {
    const error = new Error('Probe parent disconnected before cleanup was acknowledged')
    for (const acknowledgement of this.acknowledgements.values()) acknowledgement.reject(error)
    this.failures.add(error)
    this.requestStop(error)
  }

  private readonly onMessage = (message: unknown): void => {
    if (!message || typeof message !== 'object' || !('type' in message)) return
    if (message.type === 'probe-start' || message.type === 'probe-stop') {
      if (!('deadlineAt' in message) || !Number.isSafeInteger(message.deadlineAt)) return
      this.deadlineAt = Math.min(this.deadlineAt, message.deadlineAt as number)
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = this.armDeadline()
      this.acknowledgements.get('ready')?.resolve()
      if (message.type === 'probe-stop') this.requestStop(new Error('Runtime probe was stopped'))
    } else if (
      (message.type === 'probe-accepted' || message.type === 'probe-released') &&
      'id' in message && typeof message.id === 'string'
    ) {
      const action = message.type === 'probe-accepted' ? 'accepted' : 'released'
      this.acknowledgements.get(`${action}:${message.id}`)?.resolve()
    }
  }
}
