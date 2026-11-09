import type { MessagePort } from 'node:worker_threads'

import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type ExternalLspLauncherGroup,
  type ExternalLspLaunchSpec,
  type ExternalLspProcessMessage,
  type ExternalLspProjectLease,
  type ExternalLspReader,
  ExternalLspTransport,
  transferableLspBytes,
  withinLspDeadline,
} from './ExternalLspTransport'

class WorkerLspTransport extends ExternalLspTransport {
  public readonly opened: Promise<ExternalLspTransport>
  private resolveOpened!: (transport: ExternalLspTransport) => void
  private rejectOpened!: (error: Error) => void
  private reader?: ExternalLspReader
  private nextWrite = 1
  private readonly pendingWriteAcks = new Map<
    number,
    { resolve(): void; reject(error: Error): void }
  >()
  private termination?: Promise<void>
  private rejectTermination?: (error: Error) => void

  public constructor(
    private readonly id: number,
    private readonly post: (message: ExternalLspProcessMessage) => void
  ) {
    super()
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpened = resolve
      this.rejectOpened = reject
    })
  }

  public accept(reader: ExternalLspReader): void {
    this.reader = reader
    this.beginReading()
    this.post({ type: 'accept', id: this.id })
  }

  protected writeBytes(bytes: Uint8Array): Promise<void> {
    const sequence = this.nextWrite++
    return new Promise((resolve, reject) => {
      this.pendingWriteAcks.set(sequence, { resolve, reject })
      this.post({ type: 'write', id: this.id, sequence, bytes })
    })
  }

  public terminate(): Promise<void> {
    if (this.isClosed) return Promise.resolve()
    if (this.termination) return this.termination
    this.termination = new Promise<void>((resolve, reject) => {
      this.rejectTermination = reject
      void this.closed.then(() => resolve(), reject)
      this.post({ type: 'stop', id: this.id })
    })
    return this.termination
  }

  public async receive(message: ExternalLspProcessMessage): Promise<void> {
    switch (message.type) {
      case 'opened':
        this.resolveOpened(this)
        break
      case 'open-error':
        this.rejectOpened(AppError.fromJSON(message.error))
        break
      case 'failure':
        this.reportFailure(AppError.fromJSON(message.error))
        break
      case 'stop-error':
        this.rejectTermination?.(AppError.fromJSON(message.error))
        break
      case 'exit':
        this.reportExit(message.exit)
        break
      case 'closed': {
        this.rejectOpened(
          new AppError('CLOSED', 'Language server closed before transport acceptance')
        )
        if (!this.exited) this.reportExit(message.exit)
        this.finishClosed(message.exit)
        this.rejectWrites(new AppError('CLOSED', 'Language server closed'))
        break
      }
      case 'write-ack': {
        this.pendingWriteAcks.get(message.sequence)?.resolve()
        this.pendingWriteAcks.delete(message.sequence)
        break
      }
      case 'stdout':
      case 'stderr':
        if (!this.reader) throw new AppError('PROTOCOL', 'Language stream was not accepted')
        await this.reader(message.type, message.bytes)
        this.post({ type: 'read-ack', id: this.id, sequence: message.sequence })
        break
    }
  }

  private rejectWrites(error: Error): void {
    for (const write of this.pendingWriteAcks.values()) write.reject(error)
    this.pendingWriteAcks.clear()
  }

  public lost(error: Error): void {
    this.rejectOpened(error)
    this.rejectWrites(error)
    this.rejectTermination?.(error)
    this.loseConnection(error)
  }
}

/** worker 只有字节代理；没有 child_process import，更没有本地 spawn 退路。 */
export class ExternalLspWorkerTransport implements ExternalLspLauncherGroup {
  private readonly processes = new Map<number, WorkerLspTransport>()
  private nextProcess = 1
  private failure?: Error
  private lostOwnedResources = false
  private closing?: Promise<void>

  public constructor(
    private readonly port: MessagePort,
    private readonly projectLease: () => ExternalLspProjectLease | undefined
  ) {
    port.on('message', (message: ExternalLspProcessMessage) => {
      const transport = this.processes.get(message.id)
      if (!transport) return
      void transport.receive(message).catch((error: unknown) => {
        transport.lost(AppError.from(error))
        this.post({ type: 'stop', id: message.id })
      })
      if (message.type === 'closed') this.processes.delete(message.id)
    })
    port.on('messageerror', (error) => this.lose(AppError.from(error)))
    port.on('close', () => this.lose(new AppError('CLOSED', 'Language process host disconnected')))
  }

  private post(message: ExternalLspProcessMessage): void {
    try {
      if ('bytes' in message) {
        const bytes = transferableLspBytes(message.bytes)
        this.port.postMessage({ ...message, bytes }, [bytes.buffer])
      } else this.port.postMessage(message)
    } catch (error) {
      this.lose(AppError.from(error))
    }
  }

  public open(launch: ExternalLspLaunchSpec): Promise<ExternalLspTransport> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing)
      return Promise.reject(new AppError('CLOSED', 'Language launcher group is closing'))
    const lease = this.projectLease()
    if (!lease)
      return Promise.reject(new AppError('INVARIANT', 'LSP spawn needs its request project lease'))
    const id = this.nextProcess++
    const transport = new WorkerLspTransport(id, (message) => this.post(message))
    this.processes.set(id, transport)
    this.post({ type: 'open', id, lease, launch })
    return transport.opened
  }

  private lose(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.lostOwnedResources = this.processes.size > 0
    for (const transport of this.processes.values()) transport.lost(error)
    this.processes.clear()
  }

  public close(deadlineAt: number): Promise<void> {
    if (this.closing) return this.closing
    if (this.failure && this.lostOwnedResources) {
      this.closing = Promise.reject(this.failure)
      return this.closing
    }
    const processes = [...this.processes.values()]
    this.closing = withinLspDeadline(
      Promise.allSettled(processes.map((transport) => transport.terminate())),
      deadlineAt
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length)
        throw new AggregateError(failures, 'Language launcher group did not close')
    })
    return this.closing
  }
}
