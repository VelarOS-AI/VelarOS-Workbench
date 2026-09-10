import type { ActiveContextArtifact } from '@velaros-ai/agent/protocol'
import type { ConversationActionPort } from '@velaros-ai/ui/conversation'

import type { WorkbenchGoalLifecycleResult } from '@shared/workbenchKernel'

type ConversationGoalLifecycleResult = Awaited<ReturnType<ConversationActionPort['getGoalLifecycle']>>

/** 主进程的制品 → 共享会话 UI 的目标形状（agent 协议里的 resourceId 在那边叫 workspaceRoot）。 */
function projectGoal(
  goal: ActiveContextArtifact | null
): ConversationGoalLifecycleResult['goal'] {
  if (!goal) return null
  return {
    id: goal.id,
    kind: goal.kind,
    scope: goal.scope === 'session' ? 'session' : 'workspace',
    status: goal.status,
    sessionId: goal.sessionId,
    workspaceRoot: goal.resourceId,
    title: goal.title,
    content: goal.content,
    sourceMessageId: goal.sourceMessageId,
    metadata: goal.metadata,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  }
}

function toConversationResult(result: WorkbenchGoalLifecycleResult): ConversationGoalLifecycleResult {
  return result.ok ? { ok: true, goal: projectGoal(result.goal) } : { ok: false, goal: null }
}

/**
 * 独立 Workbench 的会话动作端口（Desktop desktopConversationActionPort 的对位件）：目标卡的读写与
 * 运行中「继续目标」的引导都交给主进程的原生执行栈。会话转交建议卡 Workbench 没有，结算是空操作。
 */
export const standaloneWorkbenchConversationActionPort: ConversationActionPort = {
  getGoalLifecycle: async (sessionId) =>
    toConversationResult(await window.velarosWorkbenchKernel.getGoalLifecycle({ sessionId })),
  updateGoalLifecycle: async (sessionId, action) =>
    toConversationResult(
      await window.velarosWorkbenchKernel.updateGoalLifecycle({ sessionId, action })
    ),
  provideExecutionGuidance: async (sessionId, guidance) => {
    // 与 Desktop 相同，这条引导不进对话；这一轮恰好收尾时会被拒收——目标已经恢复，下一条消息接着推进。
    await window.velarosWorkbenchKernel.provideAgentGuidance({
      sessionId,
      inputId: `goal-dock-continue:${Date.now()}`,
      text: guidance,
    })
  },
  resolveHandoffSuggestion: () => undefined,
}
