import { getGoalLifecycleStatus } from '@velaros-ai/agent/chat'
import type { ActiveContextArtifact } from '@velaros-ai/agent/protocol'

/**
 * 目标自动续跑：一轮正常跑完，而会话目标仍在进行中（没完成、没阻塞、没暂停）时，宿主替用户接着开下一轮——
 * 效果相当于替他说一句「继续」，但以宿主系统说明的身份写进会话，不冒充用户发言。
 *
 * 续跑的这一轮按目标模式执行：模型想收尾却不更新目标时，Agent 的收尾门会把它拉回来，连续挡满三次就把
 * 目标记为阻塞、这一轮以失败收尾，续跑随之停下。下面的轮数上限只是再兜一层底。
 */

/** 连续自动续跑的轮数上限：目标迟迟不收束时停下来交还用户，免得无人看管时一直开轮。 */
export const WorkbenchGoalAutoContinueRoundLimit = 20

/** 只对刚结束的那一轮作反应：切回一个很早就跑完的会话、或重启恢复会话时，不补发续跑。 */
export const WorkbenchGoalAutoContinueWindowMs = 60_000

export type WorkbenchGoalAutoContinueDecision =
  | { kind: 'continue'; objective: string }
  | { kind: 'round-limit' }
  | { kind: 'skip' }

export function resolveWorkbenchGoalAutoContinue(input: {
  /** 刚结束的这一轮是否正常完成：用户停止、执行失败都不续。 */
  runCompleted: boolean
  /** 这一轮结束到现在过去了多久。 */
  msSinceRunFinished: number
  goal: Nullable<ActiveContextArtifact>
  /** 用户排在队列里等发的消息：用户的话优先。 */
  hasQueuedUserInput: boolean
  /** 自上次用户亲自发言以来已经自动续跑的轮数。 */
  consecutiveAutoRounds: number
}): WorkbenchGoalAutoContinueDecision {
  if (
    !input.runCompleted
    || input.msSinceRunFinished > WorkbenchGoalAutoContinueWindowMs
    || input.hasQueuedUserInput
    || !input.goal
    || getGoalLifecycleStatus(input.goal) !== 'active'
  )
    return { kind: 'skip' }

  const objective = input.goal.content.trim()
  if (!objective) return { kind: 'skip' }
  if (input.consecutiveAutoRounds >= WorkbenchGoalAutoContinueRoundLimit) return { kind: 'round-limit' }

  return { kind: 'continue', objective }
}
