import { createConversationRenderSlots } from '@velaros-ai/ui/conversation'

import { WorkbenchRunningRuntimeMark } from './WorkbenchRunningRuntimeMark'
import { WorkbenchWorkerThreadPanel } from './WorkbenchWorkerThreadPanel'

/**
 * 独立 Workbench 对共享会话 UI 的宿主渲染面。
 *
 * 接管两处：运行状态行的执行体标记，以及子 Agent 线程面板——后者 Desktop 用侧栏形态，
 * Workbench 换成同族的折叠卡（见 WorkbenchWorkerThreadPanel）。其余增强槽显式保持空实现，
 * 正文替换槽继续缺席，因而仍走共享包的官方 markdown / code block 渲染路径。
 */
export const standaloneWorkbenchConversationRenderSlots = createConversationRenderSlots({
  runningRuntimeMark: () => <WorkbenchRunningRuntimeMark />,
  workerThreadPanel: ({ threads }) => <WorkbenchWorkerThreadPanel threads={threads} />,
})
