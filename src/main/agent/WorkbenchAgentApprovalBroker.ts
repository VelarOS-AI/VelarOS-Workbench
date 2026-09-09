import type { ExecutionEventBus } from '@velaros-ai/agent'
import type {
  ApprovalDecision,
  ConfirmationRequestDetail,
  ToolConfirmationDecisionOptions,
} from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void
  reject: (error: unknown) => void
}

interface WorkbenchApprovalPortInput {
  /** 会话键：确认卡的回执按它路由（与 renderer 的 chat.sessionId 同源）。 */
  sessionId: string
  /** 本轮执行 id：只用于 runtime 事件自述，路由仍以 sessionId 为准。 */
  executionId: string
  events: ExecutionEventBus
}

let confirmationSequence = 0

function nextConfirmationId(): string {
  confirmationSequence += 1
  return `workbench-confirmation:${Date.now().toString(36)}:${confirmationSequence}`
}

/**
 * Workbench 原生 Agent 的**审批通道**（宪章 §4 ApprovalPort 的宿主实现）。
 *
 * 原生执行栈此前给的是 `defaultDenyApprovalPort`：项目内核一遇到需要人审的高风险补丁就抛
 * 「需要审批，但宿主没有提供审批通道」，模型除了放弃别无选择。本类补上那条通道——它跟外部
 * 引擎的 {@link WorkbenchEngineInteractionBroker} 走**同一条协议**（`awaiting-confirmation`
 * runtime 事件出、`resolveAgentConfirmation` IPC 回），因此 renderer 一行都不用改就能弹卡。
 *
 * 职责边界：本类只做「问用户 + 等回执」。要不要问（权限模式 / 风险类别 / 会话记忆）归
 * {@link createTaskApprovalPort} 与 {@link shouldAutoApproveWorkbenchToolConfirmation}；
 * 本类拿到的每一次请求都是**已经判定必须问人**的请求。
 */
export class WorkbenchAgentApprovalBroker {
  private readonly pendingBySession = new Map<string, PendingApproval>()

  /** 为一轮执行造一个绑定会话的审批端口。 */
  public createPort(input: WorkbenchApprovalPortInput): ApprovalPort {
    const decide = (
      message: string,
      abortSignal?: AbortSignal,
      options?: ToolConfirmationDecisionOptions
    ): Promise<ApprovalDecision> => this.request(input, message, abortSignal, options)

    return {
      awaitConfirmationDecision: decide,
      awaitConfirmation: async (message, abortSignal, options) => {
        const decision = await decide(message, abortSignal, options)
        if (!decision.approved) {
          throw new AppError(
            'EXECUTION_DENIED',
            decision.message ?? '用户拒绝了本次操作。请选择其他方案。'
          )
        }
      },
    }
  }

  /** renderer 提交裁决；返回是否命中了一个等待中的请求。 */
  public resolve(sessionId: string, approved: boolean, rejectionMessage?: string): boolean {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending) return false
    this.pendingBySession.delete(sessionId)
    const message = rejectionMessage?.trim()
    pending.resolve({
      approved,
      message: approved ? null : message || '用户拒绝了本次确认请求。',
      autoApproved: false,
    })
    return true
  }

  /** 会话终止：等待中的确认按拒绝式中断收敛，不留悬挂 Promise。 */
  public cancelSession(sessionId: string, message = '会话已停止。'): void {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending) return
    this.pendingBySession.delete(sessionId)
    pending.reject(new AppError('EXECUTION_ABORTED', message))
  }

  public dispose(): void {
    for (const sessionId of [...this.pendingBySession.keys()]) {
      this.cancelSession(sessionId, 'Workbench 正在退出。')
    }
  }

  private request(
    input: WorkbenchApprovalPortInput,
    message: string,
    abortSignal: LooseOptional<AbortSignal>,
    options: LooseOptional<ToolConfirmationDecisionOptions>
  ): Promise<ApprovalDecision> {
    if (abortSignal?.aborted)
      return Promise.reject(new AppError('EXECUTION_ABORTED', '运行被终止'))
    // 同一会话同时只挂一张卡：并发确认在 createTaskApprovalPort 已串行化，这里只兜住
    // 「两条执行链共用一个 sessionId」的异常形态，避免回执错配到另一次请求。
    if (this.pendingBySession.has(input.sessionId))
      return Promise.resolve({
        approved: false,
        message: '这个会话已有一个操作正在等待确认，请先处理它。',
        autoApproved: false,
      })

    const confirmationId = nextConfirmationId()
    input.events.emitRuntime(
      ChatRuntimeEvents.awaitingConfirmation(
        input.executionId,
        message,
        options?.userActionCards,
        resolveConfirmationDetail(options),
        confirmationId
      )
    )

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.pendingBySession.delete(input.sessionId)
        reject(new AppError('EXECUTION_ABORTED', '运行被终止'))
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      this.pendingBySession.set(input.sessionId, {
        resolve: (decision) => {
          abortSignal?.removeEventListener('abort', onAbort)
          resolve(decision)
        },
        reject: (error) => {
          abortSignal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
    })
  }
}

/**
 * 确认卡的结构化信封。
 *
 * `createTaskApprovalPort` 已经把 `authorization`（标签 / 目标 / 作用域）填进 detail，
 * 这里只在宿主完全没给 detail 时兜一个 `operation-authorization` 缺省 kind，让 renderer
 * 走结构化分支而不是回落到散文。
 */
function resolveConfirmationDetail(
  options: LooseOptional<ToolConfirmationDecisionOptions>
): ConfirmationRequestDetail | undefined {
  if (options?.detail) return options.detail
  return { kind: 'operation-authorization' }
}
