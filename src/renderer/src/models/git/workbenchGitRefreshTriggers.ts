import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

/** 工作区改动后 Git 状态合并刷新的等待窗口：一次落盘的几批文件事件、Agent 连着改的几个文件并成一次刷新。 */
export const WorkbenchGitWorkspaceChangeRefreshDelayMs = 600

/**
 * Agent 执行流里的一条事件是不是「项目写工具落盘了」：工具回执成功，且带着改动的文件清单。
 * Project 的 write / edit / rollback 与外部引擎的改文件回执都用 `changedFiles` 报改了哪些文件。
 */
export function isWorkbenchAgentProjectWriteResult(envelope: unknown): boolean {
  const record = asRecord(envelope)
  if (record?.channel !== 'agent') return false

  const event = asRecord(record.payload)
  if (event?.type !== 'tool-done' || typeof event.error === 'string') return false

  const changedFiles = asRecord(event.result)?.changedFiles
  return Array.isArray(changedFiles) && changedFiles.length > 0
}
