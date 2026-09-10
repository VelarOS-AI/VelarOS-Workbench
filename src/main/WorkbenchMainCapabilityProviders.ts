import { WorkbenchAgentEngineSessionStore } from '../plugins/agent-engines/main/WorkbenchAgentEngineSessionStore'
import { WorkbenchAgentExtensionTools } from '../plugins/agent-engines/main/WorkbenchAgentExtensionTools'
import { WorkbenchAgentPluginRuntime } from '../plugins/agent-engines/main/WorkbenchAgentPluginRuntime'

import type { WorkbenchKernelCapabilityRoutes } from './kernel/WorkbenchKernelProtocol'
import { WorkbenchCodeGraphResource } from './resources/WorkbenchCodeGraphResource'
import { WorkbenchResourcePluginService } from './resources/WorkbenchResourcePluginService'
import { WorkbenchChatCheckpointService } from './workspace/git/WorkbenchChatCheckpoints'
import { WorkbenchChatRunChangeStore } from './workspace/git/WorkbenchChatRunChanges'
import { WorkbenchGitService } from './workspace/git/WorkbenchGitService'
import { WorkbenchLanguageServiceWorkerClient } from './workspace/language/LanguageServiceWorkerClient'
import { WorkbenchVelarLogicGraphService } from './workspace/language/WorkbenchVelarLogicGraphService'
import { createWorkbenchAppParts, type WorkbenchAppParts } from './workspace/Parts'
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
  /** 聊天回溯的工作区检查点（git 影子快照）。 */
  readonly chatCheckpoints: WorkbenchChatCheckpointService
  /** 每轮「本轮改动」的补丁记录（落在数据区的文件里）。 */
  readonly chatRunChanges: WorkbenchChatRunChangeStore
  readonly language: WorkbenchLanguageServiceWorkerClient
  readonly watch: WorkbenchFileWatcher
  readonly workspace: WorkbenchProjectCapabilityProvider
  readonly resourcePlugins: WorkbenchResourcePluginService
  readonly agentEngines: WorkbenchAgentPluginRuntime
  readonly kernelRoutes: WorkbenchKernelCapabilityRoutes
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
  openExternal: (url: string) => Promise<void> = async () => {
    throw new Error('当前 Workbench 宿主没有提供外部链接能力。')
  },
  pluginMarket: {
    artifactBase: () => string
    fetchImpl: typeof fetch
  } = {
    artifactBase: () => 'https://invalid.velaros.local/plugins/',
    fetchImpl: fetch,
  },
  productVersion = '0.0.0'
): WorkbenchMainCapabilityProviders {
  const language = new WorkbenchLanguageServiceWorkerClient()
  const velarLogicGraph = new WorkbenchVelarLogicGraphService(language)
  const codeGraphResource = new WorkbenchCodeGraphResource()
  const agentEngines: WorkbenchAgentPluginRuntime = new WorkbenchAgentPluginRuntime(
    new WorkbenchAgentEngineSessionStore(dataRootDir),
    new WorkbenchAgentExtensionTools(codeGraphResource, velarLogicGraph),
    openExternal,
    (engineId): boolean => resourcePlugins.isAgentPluginEnabled(engineId),
    productVersion
  )
  const resourcePlugins: WorkbenchResourcePluginService = new WorkbenchResourcePluginService(dataRootDir, codeGraphResource, {
    ...pluginMarket,
    agentEngines,
  })
  const parts = createWorkbenchAppParts(dataRootDir)
  const chatCheckpoints = new WorkbenchChatCheckpointService(() =>
    parts.storagePaths.getChatCheckpointIndexesDir()
  )
  return {
    parts,
    fileSystem: new WorkbenchProjectFileSystem(),
    git: new WorkbenchGitService(),
    chatCheckpoints,
    chatRunChanges: new WorkbenchChatRunChangeStore(chatCheckpoints, () =>
      parts.storagePaths.getChatRunChangesDir()
    ),
    language,
    watch: new WorkbenchFileWatcher({
      onFilesChanged: (event) => {
        void language.projectFilesChanged({
          projectRoot: event.rootPath,
          paths: event.paths,
        }).catch(() => {
          // 文件监听不能因语言服务器退出或项目切换制造未处理的 Promise 拒绝。
        })
      },
    }),
    workspace: new ProjectCapabilityProvider({ codeGraphResource, velarLogicGraph }),
    resourcePlugins,
    agentEngines,
    kernelRoutes: DefaultWorkbenchKernelCapabilityRoutes,
  }
}

/**
 * Domain addresses are injected here—not embedded in the generic IPC face.
 * Replacing a capability implementation or version does not change renderer
 * IPC and does not create a Desktop dependency.
 *
 * Browser 的页面操作与会话收口均由 Browser Mod 的 typed host 承载；renderer 不能自行
 * 选择 capability id、operation 或跨窗口会话。
 */
export const DefaultWorkbenchKernelCapabilityRoutes: WorkbenchKernelCapabilityRoutes =
  Object.freeze({
    'agent.execute': { capabilityId: 'velaros.agent', operation: 'execute' },
    'agent.health': { capabilityId: 'velaros.agent', operation: 'health' },
  })
