import type { WorkbenchKernelCapabilityRoutes } from './kernel/WorkbenchKernelProtocol'
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
  dataRootDir: string
): WorkbenchMainCapabilityProviders {
  return {
    parts: createWorkbenchAppParts(dataRootDir),
    fileSystem: new WorkbenchProjectFileSystem(),
    git: new WorkbenchGitService(),
    language: new WorkbenchLanguageServiceWorkerClient(),
    watch: new WorkbenchFileWatcher(),
    workspace: new ProjectCapabilityProvider(),
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
