import { WorkbenchChatCheckpointService } from './workspace/git/WorkbenchChatCheckpoints'
import { WorkbenchChatRunAttribution } from './workspace/git/WorkbenchChatRunAttribution'
import { WorkbenchChatRunChangeStore } from './workspace/git/WorkbenchChatRunChanges'
import { WorkbenchGitService } from './workspace/git/WorkbenchGitService'
import { WorkbenchLanguageServiceWorkerClient } from './workspace/language/LanguageServiceWorkerClient'
import {
  createWorkbenchAppParts,
  type WorkbenchAppParts,
  type WorkbenchAppPartsDependencies,
} from './workspace/Parts'
import {
  ProjectCapabilityProvider,
  type WorkbenchProjectCapabilityProvider,
} from './workspace/ProjectCapabilityProvider'
import { WorkbenchFileWatcher } from './workspace/watch/WorkbenchFileWatcher'
import { WorkbenchProjectFileSystem } from './workspace/WorkbenchProjectFileSystem'

export interface WorkbenchMainCapabilityProviders {
  readonly parts: WorkbenchAppParts
  readonly fileSystem: WorkbenchProjectFileSystem
  readonly git: WorkbenchGitService
  /** 「本轮改动」的工作区检查点（git 影子快照）。 */
  readonly chatCheckpoints: WorkbenchChatCheckpointService
  /** 每轮「本轮改动」的补丁记录（落在数据区的文件里）。 */
  readonly chatRunChanges: WorkbenchChatRunChangeStore
  /**
   * 每轮改动的归属账本：会话运行时报 Agent 改项目的时间窗，文件监听报原始事件，Workbench 的写入口报
   * 用户亲手的改动；「本轮改动」据此只认 Agent 的改动。
   */
  readonly chatRunAttribution: WorkbenchChatRunAttribution
  readonly language: WorkbenchLanguageServiceWorkerClient
  readonly watch: WorkbenchFileWatcher
  readonly workspace: WorkbenchProjectCapabilityProvider
}

/**
 * The only concrete host composition in the standalone app.
 *
 * IPC installers consume this injected port set and never construct services
 * themselves. Tests or future hosts can provide different implementations,
 * while the default Workspace implementation stays the published package.
 */
export function createDefaultWorkbenchMainCapabilityProviders(
  dataRootDir: string,
  dependencies: WorkbenchAppPartsDependencies
): WorkbenchMainCapabilityProviders {
  const language = new WorkbenchLanguageServiceWorkerClient()
  const parts = createWorkbenchAppParts(dataRootDir, dependencies)
  const chatCheckpoints = new WorkbenchChatCheckpointService(() =>
    parts.storagePaths.getChatCheckpointIndexesDir()
  )
  const watch = new WorkbenchFileWatcher({
    onFilesChanged: (event) => {
      void language.projectFilesChanged({
        projectRoot: event.rootPath,
        paths: event.paths,
      }).catch(() => {
        // 文件监听不能因语言服务器退出或项目切换制造未处理的 Promise 拒绝。
      })
    },
  })
  const chatRunAttribution = new WorkbenchChatRunAttribution(watch)
  return {
    parts,
    fileSystem: new WorkbenchProjectFileSystem(),
    git: new WorkbenchGitService(),
    chatCheckpoints,
    chatRunChanges: new WorkbenchChatRunChangeStore(
      chatCheckpoints,
      () => parts.storagePaths.getChatRunChangesDir(),
      Date.now,
      chatRunAttribution
    ),
    chatRunAttribution,
    language,
    watch,
    workspace: new ProjectCapabilityProvider(),
  }
}
