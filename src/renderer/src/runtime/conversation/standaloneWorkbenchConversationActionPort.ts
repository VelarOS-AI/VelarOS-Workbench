import type { ConversationActionPort } from '@velaros-ai/ui/conversation'
import type { ActiveContextArtifact } from '@velaros-ai/ui/conversation/contracts'
import { AppError } from '@velaros-ai/velaros/core/error'

import { resolveStandaloneChatSessionProjectRoot } from '../standaloneChatSessionRegistry'

type ConversationGoalLifecycleResult = Awaited<ReturnType<ConversationActionPort['getGoalLifecycle']>>

/** 目标卡上次读到的版本：改目标时按它核对（目标已变就拒绝，界面刷新后重试）；每个会话一份，有上限。 */
const goalRevisions = new Map<string, number>()
const MaxRememberedGoalRevisions = 256

function rememberGoal(sessionId: string, goal: Nullable<ActiveContextArtifact>): void {
  const revision = goal?.metadata?.goalRevision
  goalRevisions.delete(sessionId)
  if (typeof revision !== 'number') return
  goalRevisions.set(sessionId, revision)
  if (goalRevisions.size > MaxRememberedGoalRevisions)
    goalRevisions.delete(goalRevisions.keys().next().value!)
}

function sessionRequest(sessionId: string): Nullable<{ sessionId: string; projectRoot: string }> {
  const projectRoot = resolveStandaloneChatSessionProjectRoot(sessionId)
  return projectRoot ? { sessionId, projectRoot } : null
}

/**
 * 独立 Workbench 的会话动作端口（Desktop desktopConversationActionPort 的对位件）：目标卡的读写与运行中
 * 「继续目标」的引导都交给主进程的 Platform 会话。会话转交建议卡 Workbench 没有，结算是空操作。
 */
export const standaloneWorkbenchConversationActionPort: ConversationActionPort = {
  getGoalLifecycle: async (sessionId): Promise<ConversationGoalLifecycleResult> => {
    const request = sessionRequest(sessionId)
    if (!request) return { ok: true, goal: null }
    const result = await window.velarosWorkbenchConversation.getGoal(request)
    if (!result.ok) return { ok: false, goal: null }
    rememberGoal(sessionId, result.value.goal)
    return { ok: true, goal: result.value.goal }
  },
  updateGoalLifecycle: async (sessionId, action): Promise<ConversationGoalLifecycleResult> => {
    const request = sessionRequest(sessionId)
    const baseRevision = goalRevisions.get(sessionId)
    if (!request || baseRevision === undefined) return { ok: false, goal: null }
    const result = await window.velarosWorkbenchConversation.updateGoal({
      ...request,
      action,
      baseRevision,
    })
    if (!result.ok) return { ok: false, goal: null }
    rememberGoal(sessionId, result.value.goal)
    return { ok: true, goal: result.value.goal }
  },
  provideExecutionGuidance: async (sessionId, guidance) => {
    const request = sessionRequest(sessionId)
    if (!request) return
    // 这条引导不进对话；目标运行恰好收尾时，拒收必须交回调用方处理。
    const result = await window.velarosWorkbenchConversation.guidance({
      ...request,
      inputId: `goal-dock-continue:${Date.now()}`,
      text: guidance,
    })
    if (!result.ok) throw new AppError(result.code ?? 'UNAVAILABLE', result.message)
  },
  resolveHandoffSuggestion: () => undefined,
}
