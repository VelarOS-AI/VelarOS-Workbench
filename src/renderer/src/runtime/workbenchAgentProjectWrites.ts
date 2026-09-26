import { normalizeWorkbenchProjectRootPath } from '../models/project/workbenchProjects'

/**
 * 「Agent 写了项目文件」的投递点。
 *
 * 主进程在 Agent 改项目的一段时间窗（一次项目编辑、一条命令）结束时推来一条项目动静通知（见
 * `conversation-project-activity`）；会话面收到后跟上这一轮的「本轮改动」实时采集，再按项目根通知这里的
 * 订阅者（Git 状态、编辑器）。用户自己在编辑器、终端里的改动不走这里，由文件监听负责。
 */
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

/** 会话面收到一次写入后调用：通知这个项目的订阅者。 */
export function publishWorkbenchAgentProjectWrite(projectRoot: string): void {
  const listeners = projectWriteListeners.get(normalizeWorkbenchProjectRootPath(projectRoot))
  if (!listeners) return
  for (const listener of [...listeners]) listener()
}
