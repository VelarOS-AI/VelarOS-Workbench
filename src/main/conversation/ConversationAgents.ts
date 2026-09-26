import type { ActAgentSummary, ActTurnTrace } from '@velaros-ai/velaros/contracts'

import {
  type ConversationAgentProjection,
  type ConversationAgentStatus,
  ConversationAgentTextMaxChars,
} from '../../shared/workbenchConversation'

const StatusBySummary = {
  running: 'running',
  waiting: 'awaiting_input',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'aborted',
  interrupted: 'aborted',
} as const satisfies Record<ActAgentSummary['status'], ConversationAgentStatus>

type AgentContent = Omit<ConversationAgentProjection, 'startedAt' | 'updatedAt'>

interface AgentThread {
  /** 上次发出的内容（不含时刻），内容不变不重复发。 */
  content: AgentContent
  /** 第一次发出的时刻。 */
  startedAt: number
  /** 所在回合：还在跑的线程靠它定时重读。 */
  turnId: string
}

/**
 * 一次运行里子 Agent 线程的账。回合追踪里每次派发或续跑一个线程，身份是「执行 · 子任务 · 这段执行里第几次」，
 * 挂在派发它的那张脚本卡后面；运行期间定时重读执行中的回合与还有子任务在跑的回合，线程就从运行中走到收束。
 * 运行收尾时还没收束的线程不会再有消息，按中断收掉。每个线程只在内容变化时发出。
 */
export class ConversationAgentBoard {
  private readonly threads = new Map<string, AgentThread>()

  public constructor(private readonly emit: (projection: ConversationAgentProjection) => void) {}

  /** anchorOf 给出这段执行对应的脚本卡。 */
  public trace(trace: ActTurnTrace, anchorOf: (executionId: string) => Nullable<string>): void {
    const seen = new Map<string, number>()
    for (const agent of trace.agents) {
      const key = `${agent.executionId}:${agent.id}`
      const count = seen.get(key) ?? 0
      seen.set(key, count + 1)
      this.publish(trace.turnId, {
        id: `conversation:agent:${key}:${count}`,
        anchorId: anchorOf(agent.executionId),
        task: agent.task.slice(0, ConversationAgentTextMaxChars),
        profile: agent.profile,
        status: StatusBySummary[agent.status],
        answer: agent.answer.slice(0, ConversationAgentTextMaxChars),
        error: agent.error,
      })
    }
  }

  /**
   * 还有线程在跑的回合。子任务在后台跑，父任务可能早已进了后面的回合：定时重读这些回合，子任务跑完时
   * 线程跟着收束，不用等到运行收尾。
   */
  public pendingTurns(): string[] {
    const turns = new Set<string>()
    for (const { content, turnId } of this.threads.values())
      if (isActive(content.status)) turns.add(turnId)
    return [...turns]
  }

  /** 运行结束：还没收束的子任务随运行一起收掉，不会再有结果。 */
  public settle(): void {
    for (const { content, turnId } of this.threads.values())
      if (isActive(content.status)) this.publish(turnId, { ...content, status: 'aborted' })
  }

  private publish(turnId: string, content: AgentContent): void {
    const current = this.threads.get(content.id)
    if (current && JSON.stringify(current.content) === JSON.stringify(content)) return
    const startedAt = current?.startedAt ?? Date.now()
    this.threads.set(content.id, { content, startedAt, turnId })
    this.emit({ ...content, startedAt, updatedAt: Date.now() })
  }
}

function isActive(status: ConversationAgentStatus): boolean {
  return status === 'running' || status === 'awaiting_input'
}
