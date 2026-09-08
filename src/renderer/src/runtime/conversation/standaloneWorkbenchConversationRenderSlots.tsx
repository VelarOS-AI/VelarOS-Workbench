import { createConversationRenderSlots } from '@velaros-ai/ui/conversation'

import { WorkbenchRunningRuntimeMark } from './WorkbenchRunningRuntimeMark'

/**
 * 独立 Workbench 对共享会话 UI 的宿主渲染面。
 *
 * 当前只接管运行状态行的执行体标记；其余增强槽显式保持空实现，正文替换槽继续缺席，
 * 因而仍走共享包的官方 markdown / code block 渲染路径。
 */
export const standaloneWorkbenchConversationRenderSlots = createConversationRenderSlots({
  runningRuntimeMark: () => <WorkbenchRunningRuntimeMark />,
})
