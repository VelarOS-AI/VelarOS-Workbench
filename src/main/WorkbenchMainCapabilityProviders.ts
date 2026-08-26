import { WorkbenchAgentEngineSessionStore } from '../plugins/agent-engines/main/WorkbenchAgentEngineSessionStore'
import { WorkbenchAgentEnginesModRuntime } from '../plugins/agent-engines/main/WorkbenchAgentEnginesModRuntime'
import { WorkbenchAgentExtensionTools } from '../plugins/agent-engines/main/WorkbenchAgentExtensionTools'

import type { WorkbenchKernelCapabilityRoutes } from './kernel/WorkbenchKernelProtocol'
import { WorkbenchModService } from './mods/WorkbenchModService'
import { WorkbenchCodeGraphResource } from './resources/WorkbenchCodeGraphResource'
import { WorkbenchResourcePluginService } from './resources/WorkbenchResourcePluginService'
import { WorkbenchGitService } from './workspace/git/WorkbenchGitService'
import { WorkbenchLanguageServiceWorkerClient } from './workspace/language/LanguageServiceWorkerClient'
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
  readonly language: WorkbenchLanguageServiceWorkerClient
  readonly watch: WorkbenchFileWatcher
  readonly workspace: WorkbenchProjectCapabilityProvider
  readonly resourcePlugins: WorkbenchResourcePluginService
  readonly mods: WorkbenchModService
  readonly agentEngines: WorkbenchAgentEnginesModRuntime
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
  }
): WorkbenchMainCapabilityProviders {
  const codeGraphResource = new WorkbenchCodeGraphResource()
  const agentEngines = new WorkbenchAgentEnginesModRuntime(
    new WorkbenchAgentEngineSessionStore(dataRootDir),
    new WorkbenchAgentExtensionTools(codeGraphResource),
    openExternal
  )
  const resourcePlugins = new WorkbenchResourcePluginService(dataRootDir, codeGraphResource)
  const mods = new WorkbenchModService(dataRootDir, agentEngines)
  return {
    parts: createWorkbenchAppParts(dataRootDir),
    fileSystem: new WorkbenchProjectFileSystem(),
    git: new WorkbenchGitService(),
    language: new WorkbenchLanguageServiceWorkerClient(),
    watch: new WorkbenchFileWatcher(),
    workspace: new ProjectCapabilityProvider({ codeGraphResource }),
    resourcePlugins,
    mods,
    agentEngines,
    kernelRoutes: DefaultWorkbenchKernelCapabilityRoutes,
  }
}

/**
 * Domain addresses are injected here—not embedded in the generic IPC face.
 * Replacing a capability implementation or version does not change renderer
 * IPC and does not create a Desktop dependency.
 *
 * `browser.*` 保留路由但 Workbench 没有浏览器能力本体（进程内只注册 `velaros.agent`）：
 * 调用一律回 `KERNEL_CAPABILITY_UNAVAILABLE`，消费面按既有降级路径处理。
 */
export const DefaultWorkbenchKernelCapabilityRoutes: WorkbenchKernelCapabilityRoutes =
  Object.freeze({
    'agent.execute': { capabilityId: 'velaros.agent', operation: 'execute' },
    'agent.health': { capabilityId: 'velaros.agent', operation: 'health' },
    'browser.close-session': {
      capabilityId: 'velaros.browser',
      operation: 'close_session',
    },
    'browser.close-all-sessions': {
      capabilityId: 'velaros.browser',
      operation: 'close_all_sessions',
    },
  })
