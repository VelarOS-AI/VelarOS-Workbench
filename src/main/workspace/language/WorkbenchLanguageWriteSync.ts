import type { WorkbenchUserWriteSink } from '../git/WorkbenchChatRunAttribution'

import type { WorkbenchLanguageServiceWorkerClient } from './LanguageServiceWorkerClient'

type WorkbenchLanguageFilesChangedPort = Pick<
  WorkbenchLanguageServiceWorkerClient,
  'projectFilesChanged'
>

/**
 * 写完文件当场告诉语言服务，不等文件监听。
 *
 * macOS 在机器忙的时候（Agent 跑构建、装依赖时正是如此）把文件事件攒上好几秒才成批送到，这段时间里编辑器
 * 要到的诊断还是照着旧文件算的：Agent 明明已经把错误修掉，红线却还在。Agent 在 Platform 里的项目编辑由会话
 * 宿主报它写到的路径，用户在编辑器、文件树里的写入由 fs IPC 报；两路都只是提前通知，文件监听照常兜底（命令的
 * 产物仍由它送到）。
 */
export function languageSyncOnAgentEdits(
  language: WorkbenchLanguageFilesChangedPort
): (projectRoot: string, paths: readonly string[]) => void {
  return (projectRoot, paths) => notifyLanguageFilesChanged(language, projectRoot, paths)
}

export function withLanguageSyncOnUserWrites(
  inner: WorkbenchUserWriteSink,
  language: WorkbenchLanguageFilesChangedPort
): WorkbenchUserWriteSink {
  return {
    recordUserWrites: (request) => {
      inner.recordUserWrites(request)
      notifyLanguageFilesChanged(language, request.workspaceRoot, request.paths)
    },
  }
}

function notifyLanguageFilesChanged(
  language: WorkbenchLanguageFilesChangedPort,
  projectRoot: string,
  paths: readonly string[]
): void {
  if (paths.length === 0) return
  void language.projectFilesChanged({ projectRoot, paths: [...paths] }).catch(() => {
    // 语言服务 worker 退出、项目已经关闭：文件监听照常兜底，这里不制造未处理的拒绝。
  })
}
