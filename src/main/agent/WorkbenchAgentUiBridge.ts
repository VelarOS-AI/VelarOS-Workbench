import { randomUUID } from 'node:crypto'

import type { ExecutionEventBus } from '@velaros-ai/agent'
import { AppError } from '@velaros-ai/core/error'

import {
  type WorkbenchAgentUiCommand,
  WorkbenchAgentUiNoticeKind,
  type WorkbenchAgentUiRequest,
  type WorkbenchAgentUiResponse,
} from '../../shared/workbenchAgentUi'

/** 界面操作都是本地的（打开文件、加气泡），15 秒没回执就当窗口顾不上了。 */
const DefaultUiResponseTimeoutMs = 15_000

/** 一轮执行里的界面操作口：工具经它请发起这一轮的窗口在界面上做事。 */
export interface WorkbenchAgentUiPort {
  /** 返回 renderer 回执里的数据；界面报错、超时、这一轮被停下都会抛错。 */
  request(command: WorkbenchAgentUiCommand): Promise<Readonly<Record<string, unknown>>>
}

interface PendingUiRequest {
  readonly executionId: string
  readonly settle: (outcome: WorkbenchAgentUiResponse | Error) => void
}

/**
 * Agent 界面请求的挂起表。
 *
 * 请求走这一轮执行自己的事件总线（notice 事件），Kernel IPC 只把它送到发起这一轮的窗口，所以这里
 * 不必知道窗口是谁；回执经 Kernel IPC 回来（那一层核对发送方就是这一轮的窗口），按 requestId 结算。
 */
export class WorkbenchAgentUiBridge {
  private readonly pending = new Map<string, PendingUiRequest>()

  public constructor(
    private readonly options: {
      timeoutMs?: number
      createRequestId?: () => string
    } = {}
  ) {}

  public forExecution(input: {
    executionId: string
    sessionId: string
    events: ExecutionEventBus
    abortSignal: AbortSignal
  }): WorkbenchAgentUiPort {
    return { request: (command) => this.request(input, command) }
  }

  /** 结算一条回执；请求已经不在等（超时、这一轮已结束）或执行对不上时返回 false。 */
  public resolve(response: WorkbenchAgentUiResponse): boolean {
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.executionId !== response.executionId) return false
    pending.settle(response)
    return true
  }

  /** 一轮结束：还挂着的请求不会再有人回，一律失败。 */
  public cancelExecution(executionId: string, reason: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.executionId === executionId) pending.settle(new AppError('CONFLICT', reason))
    }
  }

  private request(
    input: {
      executionId: string
      sessionId: string
      events: ExecutionEventBus
      abortSignal: AbortSignal
    },
    command: WorkbenchAgentUiCommand
  ): Promise<Readonly<Record<string, unknown>>> {
    input.abortSignal.throwIfAborted()
    const requestId = this.options.createRequestId?.() ?? randomUUID()
    const timeoutMs = this.options.timeoutMs ?? DefaultUiResponseTimeoutMs

    return new Promise((resolve, reject) => {
      const onAbort = (): void =>
        settle(new AppError('ABORTED', 'This run was stopped before Workbench finished the UI action.'))
      const timer = setTimeout(
        () =>
          settle(
            new AppError(
              'TIMEOUT',
              `Workbench did not answer the UI action within ${Math.round(timeoutMs / 1000)} seconds.`
            )
          ),
        timeoutMs
      )
      const settle = (outcome: WorkbenchAgentUiResponse | Error): void => {
        if (this.pending.get(requestId)?.settle !== settle) return
        this.pending.delete(requestId)
        clearTimeout(timer)
        input.abortSignal.removeEventListener('abort', onAbort)
        if (outcome instanceof Error) reject(outcome)
        else if (outcome.ok) resolve(outcome.data)
        else reject(new AppError('CONFLICT', outcome.message))
      }

      this.pending.set(requestId, { executionId: input.executionId, settle })
      input.abortSignal.addEventListener('abort', onAbort, { once: true })
      const request: WorkbenchAgentUiRequest = {
        requestId,
        executionId: input.executionId,
        sessionId: input.sessionId,
        command,
      }
      try {
        input.events.emitAgent({ type: 'notice', kind: WorkbenchAgentUiNoticeKind, payload: request })
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
