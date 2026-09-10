import { createConversationRenderSlots } from '@velaros-ai/ui/conversation'

import { WorkbenchMessageRenderBoundary } from './WorkbenchMessageRenderFailure'
import { WorkbenchRunChangesCard } from './WorkbenchRunChangesCard'
import { WorkbenchRunningRuntimeMark } from './WorkbenchRunningRuntimeMark'
import { WorkbenchWorkerThreadPanel } from './WorkbenchWorkerThreadPanel'

/**
 * 独立 Workbench 对共享会话 UI 的宿主渲染面。
 *
 * 接管四处：运行状态行的执行体标记；子 Agent 线程面板——Desktop 用侧栏形态，Workbench 换成同族的
 * 折叠卡（见 WorkbenchWorkerThreadPanel）；单条消息的渲染错误边界；以及回答末尾的「本轮改动」卡
 * （后两处与 Desktop 同一职责）。其余增强槽显式保持空实现，正文替换槽继续缺席，因而仍走共享包的
 * 官方 markdown / code block 渲染路径。
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
})
