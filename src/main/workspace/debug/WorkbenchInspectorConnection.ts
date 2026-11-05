/**
 * 与 Node 检查器的一条连接：Chrome DevTools 协议走 WebSocket。这里只管收发——发一条命令等它的回复，把检查器
 * 推来的事件按到达顺序交给订阅者——协议里各条命令的含义归调试会话。
 *
 * 用运行时自带的 `WebSocket`（Electron 主进程的 Node、bun 都有），不引第三方库。只连本机地址。
 */
import { AppError } from '@velaros-ai/velaros/core/error'

export interface WorkbenchInspectorEvent {
  method: string
  params: Record<string, unknown>
}

interface PendingCommand {
  resolve: (result: unknown) => void
  reject: (error: AppError) => void
}

interface InspectorMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string; code?: number }
}

export class WorkbenchInspectorConnection {
  private readonly pending = new Map<number, PendingCommand>()
  private readonly eventListeners = new Set<(event: WorkbenchInspectorEvent) => void>()
  private readonly closeListeners = new Set<() => void>()
  private nextCommandId = 1
  private isClosed = false

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.receive(event.data))
    socket.addEventListener('close', () => this.settleClosed())
    socket.addEventListener('error', () => this.settleClosed())
  }

  /** 连到检查器给的 `ws://127.0.0.1:端口/标识`；连不上或超时都抛错。 */
  public static connect(url: string, timeoutMs: number): Promise<WorkbenchInspectorConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const settle = (): void => {
        clearTimeout(timer)
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
      }
      const opened = (): void => {
        settle()
        resolve(new WorkbenchInspectorConnection(socket))
      }
      const failed = (): void => {
        settle()
        socket.close()
        reject(new AppError('UNAVAILABLE', `inspector connection failed: ${url}`))
      }
      const timer = setTimeout(failed, timeoutMs)
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
    })
  }

  public get closed(): boolean {
    return this.isClosed
  }

  /** 发一条命令，等它的回复。连接已经断了、或者检查器回了错误，都以 AppError 拒绝。 */
  public send<TResult = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<TResult> {
    if (this.isClosed)
      return Promise.reject(new AppError('CLOSED', `inspector connection is closed (${method})`))

    const id = this.nextCommandId
    this.nextCommandId += 1
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(AppError.from(error, 'CLOSED'))
      }
    })
  }

  public onEvent(listener: (event: WorkbenchInspectorEvent) => void): void {
    this.eventListeners.add(listener)
  }

  /** 连接断开时通知一次（程序退出、被结束，或者这边主动关的）。 */
  public onClose(listener: () => void): void {
    if (this.isClosed) listener()
    else this.closeListeners.add(listener)
  }

  public close(): void {
    if (this.isClosed) return
    try {
      this.socket.close()
    } catch {
      // arch-guard:silent-catch-ok 连接还没建好或已经在关：反正是要断开，按已关处理。
    }
    this.settleClosed()
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return

    let message: InspectorMessage
    try {
      message = JSON.parse(data) as InspectorMessage
    } catch {
      // arch-guard:silent-catch-ok 检查器只发 JSON；读不懂的一帧丢掉，不拖垮整条连接。
      return
    }

    if (typeof message.id === 'number') {
      const command = this.pending.get(message.id)
      if (!command) return
      this.pending.delete(message.id)
      if (message.error)
        command.reject(
          new AppError('PROTOCOL', message.error.message ?? 'inspector command failed')
        )
      else command.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return

    const event = { method: message.method, params: message.params ?? {} }
    for (const listener of [...this.eventListeners]) listener(event)
  }

  private settleClosed(): void {
    if (this.isClosed) return
    this.isClosed = true

    const error = new AppError('CLOSED', 'inspector connection closed')
    for (const command of this.pending.values()) command.reject(error)
    this.pending.clear()
    for (const listener of [...this.closeListeners]) listener()
    this.closeListeners.clear()
  }
}
