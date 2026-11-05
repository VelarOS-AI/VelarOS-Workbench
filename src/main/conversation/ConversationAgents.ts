import type { ActAgentSummary, ActTurnTrace } from '@velaros-ai/velaros/contracts'
import { isPlainObject, isString } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type ConversationAgentProjection,
  type ConversationAgentStatus,
  ConversationAgentTextMaxChars,
  type WorkbenchConversationState,
} from '../../shared/workbenchConversation'

import { ConversationScriptBoard } from './ConversationScripts'
import type { ConversationWorkspaceHandle } from './WorkbenchConversationTypes'

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
  sessionId: string
  after: number
  settled: boolean
  activity: Map<string, NonNullable<ConversationAgentProjection['activity']>[number]>
  scripts: ConversationScriptBoard
  turnTimes: Map<string, number>
}

/**
 * 一次运行里子 Agent 线程的账。回合追踪里每次派发或续跑一个线程，身份是「执行 · 子任务 · 这段执行里第几次」，
 * 挂在派发它的那张脚本卡后面；运行期间定时重读执行中的回合与还有子任务在跑的回合，线程就从运行中走到收束。
 * 运行收尾时还没收束的线程不会再有消息，按中断收掉。每个线程只在内容变化时发出。
 */
export class ConversationAgentBoard {
  private readonly threads = new Map<string, AgentThread>()
  private readonly usageFacts = new Map<string, string>()
  private readonly descendants = new Map<string, number>()

  public constructor(
    private readonly emit: (projection: ConversationAgentProjection) => void,
    private readonly model: () => string | undefined = () => undefined,
    private readonly emitUsage: (
      usage: Extract<WorkbenchConversationState, { kind: 'usage-telemetry' }>
    ) => void = () => {},
    private readonly provider: () => string | undefined = () => undefined
  ) {}

  /** anchorOf 给出这段执行对应的脚本卡。 */
  public trace(trace: ActTurnTrace, anchorOf: (executionId: string) => Nullable<string>): void {
    this.recordUsage(trace, 'parent')
    const seen = new Map<string, number>()
    for (const agent of trace.agents) {
      const key = `${agent.executionId}:${agent.id}`
      const count = seen.get(key) ?? 0
      seen.set(key, count + 1)
      this.publish(
        trace.turnId,
        {
          id: `conversation:agent:${key}:${count}`,
          agentId: agent.id,
          model: this.model(),
          anchorId: anchorOf(agent.executionId),
          task: agent.task.slice(0, ConversationAgentTextMaxChars),
          profile: agent.profile,
          status: StatusBySummary[agent.status],
          answer: agent.answer.slice(0, ConversationAgentTextMaxChars),
          error: agent.error,
        },
        agent.sessionId,
        agent.startedAt
      )
    }
  }

  /** 通过根会话授权的追踪入口读取子会话，不再创建新的模型运行。 */
  public async refresh(read: NonNullable<ConversationWorkspaceHandle['trace']>): Promise<void> {
    for (const thread of this.threads.values()) {
      if (thread.settled) continue
      let after = thread.after
      let latest = after
      let pending = Number.MAX_SAFE_INTEGER
      try {
        for (;;) {
          const page = await read({
            sessionId: thread.sessionId,
            after,
            limit: 32,
            fullContent: true,
            activityLimit: 1,
          })
          for (const trace of page.turns) {
            this.recordUsage(trace, 'child')
            for (const child of trace.agents)
              if (!this.descendants.has(child.sessionId)) this.descendants.set(child.sessionId, 0)
            const timestamp = Date.parse(trace.request.createdAt ?? '')
            thread.turnTimes.set(trace.turnId, Number.isFinite(timestamp) ? timestamp : 0)
            thread.scripts.trace(trace)
            for (const record of trace.records) {
              if (record.title !== 'act:event' || record.truncated || !record.body) continue
              let value: unknown
              try {
                value = JSON.parse(record.body)
              } catch {
                continue
              }
              if (isPlainObject(value) && value.type === 'accepted' && isString(value.text)) {
                const id = `conversation:${trace.runId}:${trace.turnId}`
                thread.activity.set(id, {
                  kind: 'conversation-text',
                  timestamp: thread.turnTimes.get(trace.turnId) ?? 0,
                  payload: {
                    id,
                    runId: trace.runId,
                    turnId: trace.turnId,
                    phase: 'accepted',
                    text: value.text,
                  },
                })
              }
            }
            latest = Math.max(latest, trace.request.sequence - 1)
            if (
              trace.executions.some(
                (execution) => execution.status === 'queued' || execution.status === 'running'
              )
            )
              pending = Math.min(pending, trace.request.sequence - 1)
          }
          if (page.nextAfter === null) break
          if (page.nextAfter <= after)
            throw new AppError('PROTOCOL', 'Child transcript pagination did not advance')
          after = page.nextAfter
        }
        if (!isActive(thread.content.status)) thread.scripts.settle()
      } finally {
        // 后续页失败时也交付已读历史；没有逐条脚本回调发布，只在本轮末尾发一次。
        this.publish(thread.turnId, {
          ...thread.content,
          activity: [...thread.activity.values()].map((item) => ({
            ...item,
            timestamp: thread.turnTimes.get(item.payload.turnId) ?? 0,
          })),
        })
      }
      // 读取和下发都成功才推进，失败后相同快照仍能重试。
      thread.settled = !isActive(thread.content.status)
      thread.after = Math.min(latest, pending)
    }
    for (const [sessionId, cursor] of this.descendants) {
      let after = cursor
      let latest = after
      for (;;) {
        const page = await read({
          sessionId,
          after,
          limit: 32,
          fullContent: false,
          activityLimit: 1,
        })
        for (const trace of page.turns) {
          this.recordUsage(trace, 'child')
          latest = Math.max(latest, trace.request.sequence - 1)
          for (const child of trace.agents)
            if (!this.descendants.has(child.sessionId)) this.descendants.set(child.sessionId, 0)
        }
        if (page.nextAfter === null) break
        if (page.nextAfter <= after)
          throw new AppError('PROTOCOL', 'Child usage pagination did not advance')
        after = page.nextAfter
      }
      this.descendants.set(sessionId, latest)
    }
  }

  private recordUsage(trace: ActTurnTrace, agentRole: 'parent' | 'child'): void {
    const requestId = `${trace.sessionId}:${trace.turnId}`
    const accounting = trace.modelAccounting
    if (!accounting) return
    const usage = accounting.usage
    const fact = JSON.stringify(usage)
    if (this.usageFacts.get(requestId) === fact) return
    const timestamp = Date.parse(trace.request.createdAt ?? '')
    this.emitUsage({
      kind: 'usage-telemetry',
      requestId,
      agentRole,
      agentSessionId: trace.sessionId,
      coverage: usage.coverage,
      turn: trace.turn,
      provider: this.provider(),
      model: trace.requestSummary?.model ?? this.model() ?? '',
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens:
        usage.inputTokens !== null && usage.outputTokens !== null
          ? usage.inputTokens + usage.outputTokens
          : null,
      reasoningTokens: null,
      cacheReadInputTokens: usage.cacheReadTokens ?? undefined,
      cacheWriteInputTokens: usage.cacheWriteTokens ?? undefined,
      source: 'provider',
      confidence: 'high',
    })
    this.usageFacts.set(requestId, fact)
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

  private publish(
    turnId: string,
    content: AgentContent,
    sessionId?: string,
    phaseStartedAt?: number
  ): void {
    const current = this.threads.get(content.id)
    const next = { ...content, activity: content.activity ?? current?.content.activity }
    const startedAt = phaseStartedAt ?? current?.startedAt ?? Date.now()
    if (
      current &&
      current.startedAt === startedAt &&
      JSON.stringify(current.content) === JSON.stringify(next)
    )
      return
    // 先下发再登记已交付指纹；传输失败不能吞掉下一次相同内容的重试。
    this.emit({ ...next, startedAt, updatedAt: Date.now() })
    if (current) Object.assign(current, { content: next, turnId, startedAt })
    else {
      const activity: AgentThread['activity'] = new Map()
      const turnTimes = new Map<string, number>()
      this.threads.set(content.id, {
        content: next,
        startedAt,
        turnId,
        sessionId: sessionId!,
        after: 0,
        settled: false,
        activity,
        turnTimes,
        scripts: new ConversationScriptBoard((payload) =>
          activity.set(payload.id, {
            kind: 'conversation-script',
            payload,
            timestamp: turnTimes.get(payload.turnId) ?? 0,
          })
        ),
      })
    }
  }
}

function isActive(status: ConversationAgentStatus): boolean {
  return status === 'running' || status === 'awaiting_input'
}
