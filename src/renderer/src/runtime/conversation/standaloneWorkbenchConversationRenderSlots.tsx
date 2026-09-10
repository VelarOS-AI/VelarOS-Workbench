import { createConversationRenderSlots } from '@velaros-ai/ui/conversation'

import { WorkbenchGoalDockCard } from './WorkbenchGoalDockCard'
import { WorkbenchMessageRenderBoundary } from './WorkbenchMessageRenderFailure'
import { WorkbenchRunChangesCard } from './WorkbenchRunChangesCard'
import { WorkbenchRunningRuntimeMark } from './WorkbenchRunningRuntimeMark'
import { WorkbenchWorkerThreadPanel } from './WorkbenchWorkerThreadPanel'

/**
 * 独立 Workbench 对共享会话 UI 的宿主渲染面。
 *
 * 接管五处：运行状态行的执行体标记；子 Agent 线程面板——Desktop 用侧栏形态，Workbench 换成同族的
 * 折叠卡（见 WorkbenchWorkerThreadPanel）；单条消息的渲染错误边界；回答末尾的「本轮改动」卡；输入框
 * 上方的目标卡（后三处与 Desktop 同一职责）。其余增强槽显式保持空实现，正文替换槽继续缺席，因而仍走
 * 共享包的官方 markdown / code block 渲染路径。
 */
export const standaloneWorkbenchConversationRenderSlots = createConversationRenderSlots({
  runningRuntimeMark: () => <WorkbenchRunningRuntimeMark />,
  workerThreadPanel: ({ threads }) => <WorkbenchWorkerThreadPanel threads={threads} />,
  renderMessageBoundary: ({ message, children }) => (
    <WorkbenchMessageRenderBoundary message={message}>{children}</WorkbenchMessageRenderBoundary>
  ),
  messageFileChangeSummary: ({ message, formatPathForDisplay, onOpenEntry, onReviewEntries }) => (
    <WorkbenchRunChangesCard
      messageId={message.id}
      formatPathForDisplay={formatPathForDisplay}
      onOpenEntry={onOpenEntry}
      onReviewEntries={onReviewEntries}
    />
  ),
  // 会话卡片里 Workbench 只有目标卡；转交建议、预检动作卡、项目自动批准提示都是 Desktop 的宿主卡。
  conversationCardContent: (content) =>
    content.kind === 'goal-lifecycle' ? (
      <WorkbenchGoalDockCard
        model={content.model}
        busy={content.busy}
        onAction={content.onAction}
        onContinue={content.onContinue}
      />
    ) : null,
})
