import { EventEmitter } from 'node:events'

import { AppError, type SerializedError } from '@velaros-ai/velaros/core/error'

export const ExternalLspPendingWriteBytes = 32 * 1024 * 1024
export const ExternalLspReadChunkBytes = 64 * 1024
/** 从 owner 的绝对截止内预留既有 taskkill 上限及 stdio close 确认，不另加预算。 */
export const ExternalLspTerminationReserveMs = 5_500

export interface ExternalLspProjectLease {
  readonly projectRoot: string
  readonly generation: number
}

export interface ExternalLspLaunchSpec {
  projectRoot: string
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  shell: boolean
}

export interface ExternalLspExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export type ExternalLspReader = (
  stream: 'stdout' | 'stderr',
  bytes: Uint8Array
) => void | Promise<void>

export interface ExternalLspLauncher {
  open(launch: ExternalLspLaunchSpec): Promise<ExternalLspTransport>
}

/** 只归一个 Manager 所有的 launcher 组；不能在独立 Manager 之间共享后再单方关闭。 */
export interface ExternalLspLauncherGroup extends ExternalLspLauncher {
  close(deadlineAt: number): Promise<void>
}

/** 帧队列只有一个 owner；跨线程在途的帧也计入现有 32MiB 上限。write 接管字节所有权。 */
export abstract class ExternalLspTransport extends EventEmitter {
  public readonly closed: Promise<ExternalLspExit>
  public exited = false
  public isClosed = false
  private resolveClosed!: (exit: ExternalLspExit) => void
  private rejectClosed!: (error: Error) => void
  private unavailable = false
  private reading = false
  private failure?: Error
  private exit?: ExternalLspExit
  private readonly writes: Array<{
    bytes: Uint8Array
    length: number
    resolve(): void
    reject(error: Error): void
  }> = []
  private pendingBytes = 0
  private writing = false

  public constructor() {
    super()
    this.closed = new Promise((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
    void this.closed.catch(() => {})
  }

  public write(bytes: Uint8Array): Promise<void> {
    if (this.isClosed || this.unavailable)
      return Promise.reject(new AppError('CLOSED', 'Language server is closed'))
    if (this.pendingBytes + bytes.byteLength > ExternalLspPendingWriteBytes)
      return Promise.reject(new AppError('UNAVAILABLE', 'Language server input is backed up'))
    const result = new Promise<void>((resolve, reject) => {
      this.writes.push({ bytes, length: bytes.byteLength, resolve, reject })
      this.pendingBytes += bytes.byteLength
    })
    void this.drainWrites()
    return result
  }

  private async drainWrites(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      for (let write = this.writes.shift(); write; write = this.writes.shift()) {
        try {
          await this.writeBytes(write.bytes)
          write.resolve()
        } catch (error) {
          write.reject(AppError.from(error))
        } finally {
          this.pendingBytes -= write.length
        }
      }
    } finally {
      this.writing = false
    }
  }

  protected reportFailure(error: Error): void {
    this.failure = error
    if (this.reading) this.emit('failure', error)
  }

  protected reportExit(exit: ExternalLspExit): void {
    this.exited = true
    this.exit = exit
    if (this.reading) this.emit('exit', exit)
  }

  protected beginReading(): void {
    this.reading = true
    if (this.failure) this.emit('failure', this.failure)
    if (this.exit) this.emit('exit', this.exit)
  }

  protected finishClosed(exit: ExternalLspExit): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const write of this.writes.splice(0)) {
      this.pendingBytes -= write.length
      write.reject(new AppError('CLOSED', 'Language server is closed'))
    }
    this.resolveClosed(exit)
  }

  /** 通道失联不是子进程已退出；向等待者拒绝，不能签发成功 close。 */
  protected loseConnection(error: Error): void {
    this.unavailable = true
    this.reportFailure(error)
    this.rejectClosed(error)
    for (const write of this.writes.splice(0)) {
      this.pendingBytes -= write.length
      write.reject(error)
    }
  }

  protected abstract writeBytes(bytes: Uint8Array): Promise<void>
  public abstract accept(reader: ExternalLspReader): void
  public abstract terminate(deadlineAt?: number): Promise<void>
}

export type ExternalLspProcessMessage =
  | { type: 'open'; id: number; lease: ExternalLspProjectLease; launch: ExternalLspLaunchSpec }
  | { type: 'opened'; id: number }
  | { type: 'accept' | 'stop'; id: number }
  | { type: 'write' | 'stdout' | 'stderr'; id: number; sequence: number; bytes: Uint8Array }
  | { type: 'write-ack' | 'read-ack'; id: number; sequence: number }
  | { type: 'failure' | 'open-error' | 'stop-error'; id: number; error: SerializedError }
  | { type: 'exit' | 'closed'; id: number; exit: ExternalLspExit }

/** 共享的 pooled Buffer 不可 transfer；只转移独立、完整的 backing buffer。 */
export function transferableLspBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? (bytes as Uint8Array<ArrayBuffer>)
    : Uint8Array.from(bytes)
}

export async function withinLspDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new AppError('TIMEOUT', 'Language server did not close before its deadline')),
          Math.max(0, deadlineAt - Date.now())
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
