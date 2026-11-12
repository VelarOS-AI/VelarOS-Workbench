import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { isMainThread, type MessagePort } from 'node:worker_threads'

import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  shouldDetachExternalLspProcess,
  terminateExternalLspProcessTree,
} from './ExternalLspProcessLifecycle'
import {
  type ExternalLspExit,
  type ExternalLspLauncherGroup,
  type ExternalLspLaunchSpec,
  type ExternalLspProcessMessage,
  type ExternalLspProjectLease,
  ExternalLspReadChunkBytes,
  type ExternalLspReader,
  ExternalLspTerminationReserveMs,
  ExternalLspTransport,
  transferableLspBytes,
  withinLspDeadline,
} from './ExternalLspTransport'

const log = Log.tag('ExternalLspProcessHost')

class NativeLspTransport extends ExternalLspTransport {
  public readonly spawned: Promise<void>
  public readonly finished: Promise<ExternalLspExit>
  private readonly child: ChildProcessWithoutNullStreams
  private reader?: ExternalLspReader
  private retiring = false
  private termination?: Promise<void>
  private readonly terminationCommands = new Map<ChildProcess, Promise<void>>()
  private readonly pumping = new Set<'stdout' | 'stderr'>()

  public constructor(launch: ExternalLspLaunchSpec) {
    super()
    const command = process.platform === 'win32' && launch.shell
      ? `"${launch.command}"`
      : launch.command
    this.child = spawn(command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      detached: shouldDetachExternalLspProcess(),
      shell: launch.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const child = this.child
    this.spawned = new Promise<void>((accept, reject) => {
      child.once('spawn', accept)
      child.once('error', reject)
    })
    child.on('error', (error) => this.reportFailure(error))
    child.stdin.on('error', (error) => this.reportFailure(error))
    child.once('exit', (code, signal) => this.reportExit({ code, signal }))
    child.once('close', (code, signal) => this.finishClosed({ code, signal }))
    this.finished = this.closed.then(async (exit) => {
      // 目标 stdio close 与本资源发出的 taskkill close 都是实际资源回执。
      // 终止动作超时不能让仍未 close 的命令失去 owner，也不能耦合其它项目。
      await this.termination?.catch(() => {})
      await Promise.all(this.terminationCommands.values())
      return exit
    })
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('readable', () => void this.pump(stream))
      child[stream].on('error', (error) => this.reportFailure(error))
    }
  }

  public accept(reader: ExternalLspReader): void {
    this.reader = reader
    this.beginReading()
    void this.pump('stdout')
    void this.pump('stderr')
  }

  private async pump(stream: 'stdout' | 'stderr'): Promise<void> {
    if (this.pumping.has(stream) || !this.reader || this.retiring) return
    this.pumping.add(stream)
    try {
      const pipe = this.child[stream]
      while (!this.retiring && pipe.readableLength > 0) {
        const bytes = pipe.read(
          Math.min(ExternalLspReadChunkBytes, pipe.readableLength)
        ) as Buffer | null
        if (!bytes) break
        await this.reader(stream, Uint8Array.from(bytes))
      }
    } catch (error) {
      if (!this.retiring && !this.isClosed) {
        this.reportFailure(AppError.from(error))
        void this.terminate().catch((reason: unknown) =>
          log.warn('lsp_read_close_failed', { reason })
        )
      }
    } finally {
      this.pumping.delete(stream)
    }
  }

  protected writeBytes(bytes: Uint8Array): Promise<void> {
    return new Promise<void>((accept, reject) => {
      const stdin = this.child.stdin
      let written = false
      let drained = false
      let settled = false
      const finish = (error?: Error): void => {
        if (settled || (!error && (!written || !drained))) return
        settled = true
        stdin.off('drain', onDrain)
        stdin.off('error', onError)
        stdin.off('close', onClose)
        if (error) reject(error)
        else accept()
      }
      const onDrain = (): void => {
        drained = true
        finish()
      }
      const onError = (error: Error): void => finish(error)
      const onClose = (): void => finish(new AppError('CLOSED', 'Language server stdin closed'))
      stdin.once('error', onError)
      stdin.once('close', onClose)
      try {
        drained = stdin.write(bytes, (error) => {
          if (error) finish(error)
          else {
            written = true
            finish()
          }
        })
        if (!drained && !settled) stdin.once('drain', onDrain)
        // Bun 的 callback 可先于 write 返回；回调与返回值两项事实都到齐后必须再结算。
        finish()
      } catch (error) {
        finish(AppError.from(error))
      }
    })
  }

  public terminate(deadlineAt = Date.now() + ExternalLspTerminationReserveMs): Promise<void> {
    if (this.termination) return this.termination
    if (this.isClosed) return Promise.resolve()
    this.retiring = true
    this.reader = undefined
    this.child.stdout.removeAllListeners('readable')
    this.child.stderr.removeAllListeners('readable')
    // 不再等死 reader 的 ACK；排空残余管道，ChildProcess.close 才有机会发生。
    this.child.stdout.resume()
    this.child.stderr.resume()
    this.child.stdin.end()
    this.termination = (async () => {
      await terminateExternalLspProcessTree(
        this.child.pid,
        'SIGTERM',
        deadlineAt,
        this.terminationCommands
      )
      await withinLspDeadline(this.closed, deadlineAt)
    })()
    return this.termination
  }
}

interface ProcessEntry {
  lease: ExternalLspProjectLease
  scope?: ExternalLspWorkerProcessScope
  transport?: NativeLspTransport
  deadlineAt?: number
  closed: Promise<ExternalLspExit>
}

/** main 唯一的进程/项目代际 owner；本地消费者也必须显式使用它。 */
export class ExternalLspProcessHost implements ExternalLspLauncherGroup {
  private readonly projects = new Map<
    string,
    {
      lease: ExternalLspProjectLease
      closing?: Promise<void>
    }
  >()
  private readonly entries = new Set<ProcessEntry>()
  private readonly scopes = new Set<ExternalLspWorkerProcessScope>()
  private closing?: Promise<void>

  public constructor() {
    if (!isMainThread) throw new AppError('INVARIANT', 'LSP processes belong to the main thread')
  }

  public captureProject(projectRoot: string): ExternalLspProjectLease {
    if (this.closing) throw new AppError('CLOSED', 'Language process host is closing')
    const root = resolve(projectRoot)
    let project = this.projects.get(root)
    if (!project) {
      project = { lease: Object.freeze({ projectRoot: root, generation: 1 }) }
      this.projects.set(root, project)
    }
    if (project.closing) throw new AppError('CLOSED', 'Language project is closing')
    return project.lease
  }

  public assertProject(lease: ExternalLspProjectLease): void {
    const project = this.projects.get(lease.projectRoot)
    if (
      this.closing ||
      !project ||
      project.closing ||
      project.lease.generation !== lease.generation
    )
      throw new AppError('CLOSED', 'Language project lease is no longer active')
  }

  public createWorkerScope(port: MessagePort): ExternalLspWorkerProcessScope {
    if (this.closing) throw new AppError('CLOSED', 'Language process host is closing')
    const scope = new ExternalLspWorkerProcessScope(this, port)
    this.scopes.add(scope)
    return scope
  }

  public open(launch: ExternalLspLaunchSpec): Promise<ExternalLspTransport> {
    return this.prepareOwned(this.captureProject(launch.projectRoot), launch).opened
  }

  public prepareOwned(
    lease: ExternalLspProjectLease,
    launch: ExternalLspLaunchSpec,
    scope?: ExternalLspWorkerProcessScope
  ): { opened: Promise<NativeLspTransport>; closed: Promise<ExternalLspExit> } {
    let resolveClosed!: (exit: ExternalLspExit) => void
    const entry: ProcessEntry = {
      lease,
      scope,
      closed: new Promise((accept) => {
        resolveClosed = accept
      }),
    }
    this.entries.add(entry)
    const opened = (async () => {
      try {
        // 旧 worker 的资源未收束时，replacement 不并排拉起同一项目服务器。
        const retiring = [...this.entries].filter(
          (other) =>
            other !== entry &&
            other.lease.projectRoot === lease.projectRoot &&
            other.scope !== scope &&
            other.scope?.closing
        )
        if (retiring.length)
          await withinLspDeadline(
            Promise.all(retiring.map((other) => other.closed)),
            Math.min(...retiring.map((other) => other.scope!.deadlineAt!))
          )
        this.assertProject(lease)
        scope?.assertActive(lease)
        const transport = new NativeLspTransport(launch)
        entry.transport = transport
        void transport.finished.then((exit) => {
          this.entries.delete(entry)
          resolveClosed(exit)
        })
        await transport.spawned
        this.assertProject(lease)
        scope?.assertActive(lease)
        return transport
      } catch (error) {
        if (entry.transport) {
          await entry.transport.terminate(entry.deadlineAt)
        } else {
          this.entries.delete(entry)
          resolveClosed({ code: null, signal: null })
        }
        throw error
      }
    })()
    return { opened, closed: entry.closed }
  }

  public releaseProject(
    projectRoot: string,
    deadlineAt: number,
    finish: () => Promise<void>
  ): Promise<void> {
    const root = resolve(projectRoot)
    const project = this.projects.get(root)
    if (!project) return finish()
    if (project.closing) return project.closing
    project.lease = Object.freeze({ projectRoot: root, generation: project.lease.generation + 1 })
    const closing = Promise.resolve().then(async () => {
      const results = await withinLspDeadline(
        Promise.allSettled([
          this.closeEntries(
            [...this.entries].filter((entry) => entry.lease.projectRoot === root),
            deadlineAt
          ),
          Promise.resolve().then(finish),
        ]),
        deadlineAt
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) throw new AggregateError(failures, 'Language project did not close')
    })
    project.closing = closing
    void closing.then(
      () => {
        if (project.closing === closing) project.closing = undefined
      },
      () => {}
    )
    return closing
  }

  public closeScope(scope: ExternalLspWorkerProcessScope, deadlineAt: number): Promise<void> {
    return this.closeEntries(
      [...this.entries].filter((entry) => entry.scope === scope),
      deadlineAt
    )
  }

  private async closeEntries(entries: ProcessEntry[], deadlineAt: number): Promise<void> {
    for (const entry of entries)
      entry.deadlineAt = Math.min(entry.deadlineAt ?? deadlineAt, deadlineAt)
    const force = (): void => {
      for (const entry of entries) {
        if (entry.transport) entry.scope?.abandonReads(entry.transport)
        if (entry.transport)
          void entry.transport
            .terminate(entry.deadlineAt)
            .catch((error: unknown) => log.warn('lsp_process_close_failed', { error }))
      }
    }
    const timer = setTimeout(
      force,
      Math.max(0, deadlineAt - ExternalLspTerminationReserveMs - Date.now())
    )
    try {
      await withinLspDeadline(Promise.all(entries.map((entry) => entry.closed)), deadlineAt)
    } finally {
      clearTimeout(timer)
    }
  }

  public close(deadlineAt = Date.now() + ExternalLspTerminationReserveMs): Promise<void> {
    if (this.closing) return this.closing
    this.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...[...this.scopes].map((scope) => scope.close(deadlineAt)),
        ...[...this.projects.values()].flatMap((project) =>
          project.closing ? [project.closing] : []
        ),
        this.closeEntries([...this.entries], deadlineAt),
      ])
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) throw new AggregateError(failures, 'Language processes did not close')
      this.projects.clear()
    })
    return this.closing
  }

  public forgetScope(scope: ExternalLspWorkerProcessScope): void {
    this.scopes.delete(scope)
  }
}

/** 每个实例保留自己的关闭回执，current worker 换掉后也不能丢弃它。 */
export class ExternalLspWorkerProcessScope {
  public closing?: Promise<void>
  public deadlineAt?: number
  private readonly projects = new Map<string, number>()
  private readonly processes = new Map<number, NativeLspTransport>()
  private readonly pendingOpens = new Map<number, { stop: boolean }>()
  private readonly reads = new Map<
    number,
    { transport: NativeLspTransport; resolve(): void; reject(error: Error): void }
  >()
  private nextRead = 1

  public constructor(
    private readonly host: ExternalLspProcessHost,
    private readonly port: MessagePort
  ) {
    port.on('message', (message: ExternalLspProcessMessage) => {
      void this.receive(message).catch((error: unknown) => {
        this.send({ type: 'failure', id: message.id, error: AppError.from(error).toJSON() })
      })
    })
    port.on(
      'messageerror',
      () =>
        void this.close(Date.now() + ExternalLspTerminationReserveMs).catch((error: unknown) =>
          log.warn('lsp_scope_close_failed', { error })
        )
    )
    port.on(
      'close',
      () =>
        void this.close(Date.now() + ExternalLspTerminationReserveMs).catch((error: unknown) =>
          log.warn('lsp_scope_close_failed', { error })
        )
    )
    port.unref()
  }

  public bindProject(lease: ExternalLspProjectLease): void {
    this.host.assertProject(lease)
    if (this.closing) throw new AppError('CLOSED', 'Language worker is closing')
    this.projects.set(lease.projectRoot, lease.generation)
  }

  public assertActive(lease: ExternalLspProjectLease): void {
    if (this.closing || this.projects.get(lease.projectRoot) !== lease.generation)
      throw new AppError('CLOSED', 'Language worker project lease is no longer active')
  }

  private send(message: ExternalLspProcessMessage): void {
    try {
      if ('bytes' in message) {
        const bytes = transferableLspBytes(message.bytes)
        this.port.postMessage({ ...message, bytes }, [bytes.buffer])
      } else this.port.postMessage(message)
    } catch {
      void this.close(Date.now() + ExternalLspTerminationReserveMs).catch((error: unknown) =>
        log.warn('lsp_scope_close_failed', { error })
      )
    }
  }

  private async receive(message: ExternalLspProcessMessage): Promise<void> {
    if (message.type === 'open') {
      let registered = false
      const pending = { stop: false }
      this.pendingOpens.set(message.id, pending)
      try {
        this.assertActive(message.lease)
        const opening = this.host.prepareOwned(message.lease, message.launch, this)
        registered = true
        void opening.closed.then((exit) => {
          const deliverClosed = (): void => {
            this.processes.delete(message.id)
            this.send({ type: 'closed', id: message.id, exit })
          }
          // 先交付 opened/open-error，再交付 close；不能先让 worker 丢掉待接纳项。
          void opening.opened.then(deliverClosed, deliverClosed)
        })
        const transport = await opening.opened
        this.processes.set(message.id, transport)
        void transport.closed.then(() => this.abandonReads(transport))
        transport.on('failure', (error: Error) =>
          this.send({ type: 'failure', id: message.id, error: AppError.from(error).toJSON() })
        )
        transport.on('exit', (exit: ExternalLspExit) =>
          this.send({ type: 'exit', id: message.id, exit })
        )
        if (pending.stop || this.closing) {
          await transport.terminate(this.deadlineAt)
          throw new AppError('CLOSED', 'Language transport handoff was cancelled')
        }
        this.send({ type: 'opened', id: message.id })
      } catch (error) {
        this.send({ type: 'open-error', id: message.id, error: AppError.from(error).toJSON() })
        if (!registered)
          this.send({ type: 'closed', id: message.id, exit: { code: null, signal: null } })
      } finally {
        this.pendingOpens.delete(message.id)
      }
      return
    }
    if (message.type === 'read-ack') {
      this.reads.get(message.sequence)?.resolve()
      this.reads.delete(message.sequence)
      return
    }
    const transport = this.processes.get(message.id)
    if (!transport && message.type === 'stop') {
      const opening = this.pendingOpens.get(message.id)
      if (opening) opening.stop = true
    }
    if (!transport) return
    if (message.type === 'accept')
      transport.accept(
        (stream, bytes) =>
          new Promise<void>((resolveRead, reject) => {
            const sequence = this.nextRead++
            this.reads.set(sequence, { transport, resolve: resolveRead, reject })
            this.send({ type: stream, id: message.id, sequence, bytes })
          })
      )
    else if (message.type === 'write') {
      await transport.write(message.bytes)
      this.send({ type: 'write-ack', id: message.id, sequence: message.sequence })
    } else if (message.type === 'stop') {
      try {
        await transport.terminate()
      } catch (error) {
        this.send({ type: 'stop-error', id: message.id, error: AppError.from(error).toJSON() })
      }
    }
  }

  public abandonReads(transport?: NativeLspTransport): void {
    for (const [sequence, read] of this.reads) {
      if (transport && read.transport !== transport) continue
      read.reject(new AppError('CLOSED', 'Language reader closed'))
      this.reads.delete(sequence)
    }
  }

  public close(deadlineAt: number): Promise<void> {
    if (this.closing) return this.closing
    this.deadlineAt = deadlineAt
    this.closing = Promise.resolve().then(() => this.host.closeScope(this, deadlineAt))
    void this.closing.then(
      () => {
        this.abandonReads()
        this.projects.clear()
        this.processes.clear()
        this.port.close()
        this.host.forgetScope(this)
      },
      () => {}
    )
    return this.closing
  }
}
