import type {
  WorkbenchAgentProjectActivitySource,
  WorkbenchUserWriteSink,
} from '../git/WorkbenchChatRunAttribution'

import type { WorkbenchLanguageServiceWorkerClient } from './LanguageServiceWorkerClient'

type WorkbenchLanguageFilesChangedPort = Pick<
  WorkbenchLanguageServiceWorkerClient,
  'projectFilesChanged'
>

/**
 * 写完文件当场告诉语言服务，不等文件监听。
 *
 * macOS 在机器忙的时候（Agent 跑构建、装依赖时正是如此）把文件事件攒上好几秒才成批送到，这段时间里编辑器要到的
 * 诊断还是照着旧文件算的：Agent 明明已经把错误修掉，红线却还在。Agent 的写文件工具报它改过的路径（改动归属账本
 * 也靠这个），用户在编辑器、文件树里的写入由 fs IPC 报；两路都只是提前通知，文件监听照常兜底（命令的产物、
 * 外部引擎自己写盘的文件仍由它送到）。
 */
export function withLanguageSyncOnAgentWrites(
  inner: WorkbenchAgentProjectActivitySource,
  language: WorkbenchLanguageFilesChangedPort
): WorkbenchAgentProjectActivitySource {
  return {
    activityFor: (request) => {
      const port = inner.activityFor(request)
      return {
        beginFileWrite: () => {
          const finish = port.beginFileWrite()
          return (changedPaths) => {
            finish(changedPaths)
            notifyLanguageFilesChanged(language, request.projectRoot, changedPaths)
          }
        },
        beginCommand: () => port.beginCommand(),
      }
    },
  }
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
