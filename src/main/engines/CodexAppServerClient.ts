import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

import { isNonBlankString, isNumber, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

import {
  describeEngineExitStatus,
  spawnEngineProcess,
  terminateEngineProcess,
  type WorkbenchEngineCommand,
} from './WorkbenchEngineProcess'

const log = Log.tag('CodexAppServerClient')

const StderrTailChars = 4_000

export type CodexRpcId = number | string

/** app-server 发来的一条：请求（带 id 与 method）、通知（只有 method）或回执（只有 id）。 */
export interface CodexRpcMessage {
  id?: CodexRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

/** app-server 发给宿主、要回执的请求（问审批、问用户）。 */
export interface CodexServerRequest {
  id: CodexRpcId
  method: string
  params: Record<string, unknown>
}

export interface CodexAppServerHandlers {
  notification(method: string, params: Record<string, unknown>): void
  /** 返回值作为成功回执；抛错作为错误回执。 */
  request(request: CodexServerRequest): Promise<unknown>
  /** 进程退出或连接断了：之后的请求都会失败，下次要用时重新起。 */
  closed(error: AppError): void
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: unknown): void
}

/**
 * Codex 的 app-server（`codex app-server`）：逐行 JSON 的 JSON-RPC。只管传输、请求与回执对应，以及握手；
 * 消息的意思由引擎解释。一个进程跑所有会话（每个会话一条 thread）。
 */
export class CodexAppServerClient {
  private readonly pending = new Map<CodexRpcId, PendingRequest>()
  private nextId = 1
  private stderrTail = ''
  private closed = false

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: CodexAppServerHandlers
  ) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.receive(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-StderrTailChars)
    })
    child.stdin.on('error', (error) =>
      log.debug('写不进 Codex app-server 了', { error: AppError.getMessage(error) })
    )
    child.once('error', (error) =>
      this.fail(new AppError('UNAVAILABLE', workbenchMainText('engines.codexStartFailed', { reason: error.message })))
    )
    child.once('close', (code, signal) => {
      const status = describeEngineExitStatus(code, signal)
      const stderr = this.stderrTail.trim()
      this.fail(
        new AppError(
          'CLOSED',
          stderr
            ? workbenchMainText('engines.exitedWithOutput', { engine: 'Codex', status, stderr })
            : workbenchMainText('engines.exited', { engine: 'Codex', status })
        )
      )
    })
  }

  /** 起 app-server 并握手；失败时进程一并停下。 */
  public static async start(
    command: WorkbenchEngineCommand,
    clientVersion: string,
    handlers: CodexAppServerHandlers
  ): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(
      spawnEngineProcess(command, ['app-server'], homedir()),
      handlers
    )
    try {
      await client.request('initialize', {
        clientInfo: {
          name: 'velaros-workbench',
          title: 'VelarOS Workbench',
          version: clientVersion,
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      client.notify('initialized')
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  public get isClosed(): boolean {
    return this.closed
  }

  public request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new AppError('CLOSED', workbenchMainText('engines.codexExited')))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  public notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  public close(): void {
    if (this.closed) return
    terminateEngineProcess(this.child)
    this.fail(new AppError('CLOSED', workbenchMainText('engines.codexClosed')))
  }

  private write(message: CodexRpcMessage & { jsonrpc?: never }): void {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      log.debug('Codex 输出了一行不是 JSON 的内容', { line: line.slice(0, 200) })
      return
    }
    if (!isPlainObject(message)) return
    const { id, method } = message
    const params = isPlainObject(message.params) ? message.params : {}
    if (isRpcId(id) && !isString(method)) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (message.error !== undefined)
        pending.reject(new AppError('PROTOCOL', rpcErrorMessage(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (!isString(method)) return
    if (!isRpcId(id)) {
      this.handlers.notification(method, params)
      return
    }
    void Promise.resolve()
      .then(() => this.handlers.request({ id, method, params }))
      .then(
        (result) => this.write({ id, result: result ?? {} }),
        (error: unknown) =>
          this.write({ id, error: { code: -32000, message: AppError.getMessage(error) } })
      )
  }

  private fail(error: AppError): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.handlers.closed(error)
  }
}

function isRpcId(value: unknown): value is CodexRpcId {
  return isNumber(value) || isString(value)
}

function rpcErrorMessage(error: unknown): string {
  if (isPlainObject(error) && isNonBlankString(error.message)) return error.message
  return isString(error) ? error : workbenchMainText('engines.codexRequestRejected')
}
