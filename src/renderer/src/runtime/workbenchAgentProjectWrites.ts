import { normalizeWorkbenchProjectRootPath } from '../models/project/workbenchProjects'

import { asRecord } from './standaloneWorkbenchChatRuntime'

/**
 * 「Agent 写了项目文件」的唯一识别器与投递点。
 *
 * 识别：一次可能改动项目文件的工具调用出了结果——主 Agent 的工具事件，以及 `worker-thread` 事件里子 Agent
 * 的工具事件（同一形状包在 chatEvent 里；编辑类子 Agent 也写盘）。外部引擎把自己的改文件、跑命令也报成
 * 这几个工具名（见 agent-engines 的 Codex / Claude 运行时），同样认得。结果带错也算：失败的命令、中途出错的
 * 编辑都可能已经动了盘，而消费方做的都是幂等的重新比对，多一次不出错，漏一次才出错。
 *
 * 投递：会话面（standaloneWorkbenchChatAdapter）是执行事件的唯一观察点，每一轮一个识别器。识别到写入后，
 * 这一轮的「本轮改动」实时采集由会话面直接跟上；别的关心工作区的界面（Git 状态）按项目根订阅这里。
 * 用户自己在编辑器、终端里的改动不走这里，由文件监听负责。
 */

/** 可能改动项目文件的工具：它们的结果一到，工作区就可能变了。 */
const WorkspaceWritingToolNames: ReadonlySet<string> = new Set([
  'project:edit',
  'project:write',
  'project:rollback',
  'project:run',
])

export interface WorkbenchAgentProjectWriteTracker {
  /** 喂一条 agent 事件；它是某次项目写工具调用的结果时返回 true，别的事件一律 false。 */
  observe: (event: Record<string, unknown>) => boolean
}

type ToolEvent =
  | { readonly phase: 'start'; readonly toolCallId: string; readonly toolName: string }
  | { readonly phase: 'done'; readonly toolCallId: string }

/** 主 Agent 的工具事件，或 `worker-thread` 事件里子 Agent 的工具事件。 */
function readToolEvent(event: Record<string, unknown>): ToolEvent | null {
  const source = event.type === 'worker-thread' ? asRecord(asRecord(event.payload).chatEvent) : event
  const { toolCallId, toolName } = source
  if (typeof toolCallId !== 'string') return null
  if (source.type === 'tool-start' && typeof toolName === 'string')
    return { phase: 'start', toolCallId, toolName }
  return source.type === 'tool-done' ? { phase: 'done', toolCallId } : null
}

/**
 * 一轮执行一个：结果事件（tool-done）不带工具名，要靠同一轮里先到的 tool-start 认出它是不是写工具。
 * 跟着执行一起回收，没出结果就被中止的调用不会越攒越多。
 */
export function createWorkbenchAgentProjectWriteTracker(): WorkbenchAgentProjectWriteTracker {
  const writingToolCalls = new Set<string>()
  return {
    observe: (event) => {
      const tool = readToolEvent(event)
      if (!tool) return false
      if (tool.phase === 'done') return writingToolCalls.delete(tool.toolCallId)
      if (WorkspaceWritingToolNames.has(tool.toolName)) writingToolCalls.add(tool.toolCallId)
      return false
    },
  }
}

const projectWriteListeners = new Map<string, Set<() => void>>()

/** 订阅某个项目里 Agent 的写入（主 Agent 与子 Agent）；返回退订函数。 */
export function subscribeWorkbenchAgentProjectWrites(
  projectRoot: string,
  listener: () => void
): () => void {
  const key = normalizeWorkbenchProjectRootPath(projectRoot)
  let listeners = projectWriteListeners.get(key)
  if (!listeners) {
    listeners = new Set()
    projectWriteListeners.set(key, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = projectWriteListeners.get(key)
    current?.delete(listener)
    if (current?.size === 0) projectWriteListeners.delete(key)
  }
}

/** 会话面识别到一次写入后调用：通知这个项目的订阅者。 */
export function publishWorkbenchAgentProjectWrite(projectRoot: string): void {
  const listeners = projectWriteListeners.get(normalizeWorkbenchProjectRootPath(projectRoot))
  if (!listeners) return
  for (const listener of [...listeners]) listener()
}
