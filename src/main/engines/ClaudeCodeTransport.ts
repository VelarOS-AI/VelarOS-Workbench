import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

import { isNonBlankString, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  spawnEngineProcess,
  terminateEngineProcess,
  type WorkbenchEngineCommand,
} from './WorkbenchEngineProcess'

const log = Log.tag('ClaudeCodeTransport')

/** stderr 只留末尾这么多，进程异常退出时带进错误说明。 */
const StderrTailChars = 4_000

/**
 * 与 Claude Code 命令行对话的参数：非交互模式，输入输出都是逐行 JSON（stream-json），工具权限经控制通道
 * 问宿主（`--permission-prompt-tool stdio`）。与官方 Agent SDK 起命令行的方式相同。
 */
export const ClaudeCodeProtocolArgs: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
  '--permission-prompt-tool',
  'stdio',
]

/** 命令行发来的一条消息（system / assistant / user / stream_event / result……）。 */
export type ClaudeCodeMessage = Record<string, unknown> & { type: string }

/** 命令行发给宿主的控制请求（问工具权限等）；命令行撤回它时 signal 中止。 */
export interface ClaudeCodeControlRequest {
  subtype: string
  request: Record<string, unknown>
  signal: AbortSignal
}

export type ClaudeCodeControlHandler = (request: ClaudeCodeControlRequest) => Promise<unknown>

interface PendingControl {
  resolve(value: Record<string, unknown>): void
  reject(error: unknown): void
}

/** 进程退出的情况；stderr 是末尾一段。 */
export interface ClaudeCodeExit {
  code: Nullable<number>
  signal: Nullable<NodeJS.Signals>
  stderr: string
}

/**
 * Claude Code 命令行的一个进程：写入用户消息与控制请求，读出消息流；命令行发来的控制请求交给 handler，
 * 它的返回值原样作为成功回执，抛错作为错误回执。只管传输与请求对应，不解释消息。
 */
export class ClaudeCodeTransport {
  public readonly exited: Promise<ClaudeCodeExit>
  private readonly messages: ClaudeCodeMessage[] = []
  private readonly waiters: Array<() => void> = []
  private readonly pending = new Map<string, PendingControl>()
  private readonly inbound = new Map<string, AbortController>()
  private stderrTail = ''
  private finished = false
  private writable = true

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onControlRequest: ClaudeCodeControlHandler
  ) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.receive(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-StderrTailChars)
    })
    // 进程已经退出时再写会报 EPIPE：记下来，不让它变成未处理的异常。
    child.stdin.on('error', (error) => {
      this.writable = false
      log.debug('写不进 Claude Code 了', { error: AppError.getMessage(error) })
    })
    this.exited = new Promise<ClaudeCodeExit>((resolve) => {
      let spawnError: Error | undefined
      child.once('error', (error) => {
        spawnError = error
      })
      child.once('close', (code, signal) => {
        this.writable = false
        this.finished = true
        const stderr = [spawnError?.message, this.stderrTail.trim()]
          .filter(isNonBlankString)
          .join('\n')
        const reason = new AppError('UNAVAILABLE', describeExit(code, signal, stderr))
        for (const request of this.pending.values()) request.reject(reason)
        this.pending.clear()
        for (const controller of this.inbound.values()) controller.abort(reason)
        this.inbound.clear()
        this.wake()
        resolve({ code, signal, stderr })
      })
    })
  }

  public static start(
    command: WorkbenchEngineCommand,
    args: readonly string[],
    cwd: string,
    onControlRequest: ClaudeCodeControlHandler = async (request) => {
      throw new AppError('PROTOCOL', `不支持的控制请求：${request.subtype}`)
    }
  ): ClaudeCodeTransport {
    return new ClaudeCodeTransport(spawnEngineProcess(command, args, cwd), onControlRequest)
  }

  /** 握手：命令行回报它的模型目录、账号等；之后才能交用户消息。 */
  public initialize(
    options: { appendSystemPrompt?: string } = {}
  ): Promise<Record<string, unknown>> {
    return this.request({
      subtype: 'initialize',
      hooks: null,
      appendSystemPrompt: options.appendSystemPrompt,
    })
  }

  /** 打断正在跑的这一回合（命令行收尾后照常发出 result）。 */
  public async interrupt(): Promise<void> {
    await this.request({ subtype: 'interrupt' })
  }

  /** 交一条用户消息；content 是 Anthropic 消息的内容块（文字、图片）。 */
  public sendUser(content: readonly unknown[]): void {
    this.write({
      type: 'user',
      session_id: '',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })
  }

  /** 不再有输入：命令行处理完手上的就退出。 */
  public endInput(): void {
    if (!this.writable) return
    this.writable = false
    this.child.stdin.end()
  }

  /** 停下进程连同它起的命令。 */
  public close(): void {
    this.writable = false
    terminateEngineProcess(this.child)
  }

  /** 逐条读出消息，进程退出且读完为止。 */
  public async *read(): AsyncGenerator<ClaudeCodeMessage> {
    while (true) {
      const message = this.messages.shift()
      if (message) {
        yield message
        continue
      }
      if (this.finished) return
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  private request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.finished) return Promise.reject(new AppError('UNAVAILABLE', 'Claude Code 已经退出。'))
    const requestId = randomUUID()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.write({ type: 'control_request', request_id: requestId, request })
    })
  }

  private write(message: Record<string, unknown>): void {
    if (!this.writable) throw new AppError('UNAVAILABLE', 'Claude Code 已经不再接收输入。')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      log.debug('Claude Code 输出了一行不是 JSON 的内容', { line: line.slice(0, 200) })
      return
    }
    if (!isPlainObject(message) || !isString(message.type)) return
    switch (message.type) {
      case 'control_response':
        this.receiveResponse(message.response)
        return
      case 'control_request':
        this.receiveRequest(message)
        return
      case 'control_cancel_request':
        if (isString(message.request_id))
          this.inbound
            .get(message.request_id)
            ?.abort(new AppError('CANCELLED', 'Claude Code 撤回了请求。'))
        return
      case 'keep_alive':
        return
      default:
        this.messages.push(message as ClaudeCodeMessage)
        this.wake()
    }
  }

  private receiveResponse(response: unknown): void {
    if (!isPlainObject(response) || !isString(response.request_id)) return
    const pending = this.pending.get(response.request_id)
    if (!pending) return
    this.pending.delete(response.request_id)
    if (response.subtype === 'success')
      pending.resolve(isPlainObject(response.response) ? response.response : {})
    else
      pending.reject(
        new AppError(
          'UNAVAILABLE',
          isNonBlankString(response.error) ? response.error : 'Claude Code 拒绝了请求。'
        )
      )
  }

  private receiveRequest(message: Record<string, unknown>): void {
    const requestId = message.request_id
    const request = message.request
    if (!isString(requestId) || !isPlainObject(request)) return
    const controller = new AbortController()
    this.inbound.set(requestId, controller)
    void Promise.resolve()
      .then(() =>
        this.onControlRequest({
          subtype: isString(request.subtype) ? request.subtype : '',
          request,
          signal: controller.signal,
        })
      )
      .then(
        (result) => ({
          subtype: 'success',
          request_id: requestId,
          response: isPlainObject(result) ? result : {},
        }),
        (error: unknown) => ({
          subtype: 'error',
          request_id: requestId,
          error: AppError.getMessage(error),
        })
      )
      .then((response) => {
        // 命令行已经撤回或退出的请求不再回执。
        if (this.inbound.get(requestId) !== controller || controller.signal.aborted) return
        this.inbound.delete(requestId)
        if (this.writable) this.write({ type: 'control_response', response })
      })
      .catch((error: unknown) =>
        log.warn('回执 Claude Code 的控制请求失败', { error: AppError.getMessage(error) })
      )
      .finally(() => {
        if (this.inbound.get(requestId) === controller) this.inbound.delete(requestId)
      })
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}

function describeExit(
  code: Nullable<number>,
  signal: Nullable<NodeJS.Signals>,
  stderr: string
): string {
  const status = signal ? `被信号 ${signal} 结束` : `退出码 ${String(code)}`
  return stderr ? `Claude Code 已退出（${status}）：${stderr}` : `Claude Code 已退出（${status}）。`
}
