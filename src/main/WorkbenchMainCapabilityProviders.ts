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
  /** 每轮「本轮改动」的补丁记录（落在数据区的文件里）。 */
  readonly chatRunChanges: WorkbenchChatRunChangeStore
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
  dependencies: WorkbenchAppPartsDependencies,
  /**
   * 登录 shell 的环境：Git 命令连同它跑的提交钩子、git-lfs 都跑在里面。
   */
  loginEnvironment: () => Promise<NodeJS.ProcessEnv>
): WorkbenchMainCapabilityProviders {
  const language = new WorkbenchLanguageServiceWorkerClient()
  const parts = createWorkbenchAppParts(dataRootDir, { ...dependencies, loginEnvironment })
  const watch = new WorkbenchFileWatcher({
    onFilesChanged: (event) => {
      void language
        .projectFilesChanged({
          projectRoot: event.rootPath,
          paths: event.paths,
        })
        .catch(() => {
          // 文件监听不能因语言服务器退出或项目切换制造未处理的 Promise 拒绝。
        })
    },
  })
  return {
    parts,
    fileSystem: new WorkbenchProjectFileSystem(),
    git: new WorkbenchGitService({ environment: loginEnvironment }),
    chatRunChanges: new WorkbenchChatRunChangeStore(() =>
      parts.storagePaths.getChatRunChangesDir()
    ),
    language,
    watch,
    workspace: new ProjectCapabilityProvider(),
  }
}
