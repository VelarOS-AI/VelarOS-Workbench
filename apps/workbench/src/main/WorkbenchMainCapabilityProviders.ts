import type { WorkbenchKernelCapabilityRoutes } from './kernel/WorkbenchKernelIpc'
import { WorkbenchGitService } from './workspace/git/WorkbenchGitService'
import { WorkbenchLanguageServiceWorkerClient } from './workspace/language/LanguageServiceWorkerClient'
import { createWorkbenchAppParts, type WorkbenchAppParts } from './workspace/Parts'
import {
  PublishedWorkspaceCapabilityProvider,
  type WorkbenchWorkspaceCapabilityProvider,
} from './workspace/PublishedWorkspaceCapabilityProvider'
import { WorkbenchFileWatcher } from './workspace/watch/WorkbenchFileWatcher'
import { WorkbenchProjectFileSystem } from './workspace/WorkbenchProjectFileSystem'

export interface WorkbenchMainCapabilityProviders {
  readonly parts: WorkbenchAppParts
  readonly fileSystem: WorkbenchProjectFileSystem
  readonly git: WorkbenchGitService
  readonly language: WorkbenchLanguageServiceWorkerClient
  readonly watch: WorkbenchFileWatcher
  readonly workspace: WorkbenchWorkspaceCapabilityProvider
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
    workspace: new PublishedWorkspaceCapabilityProvider(),
    kernelRoutes: DefaultWorkbenchKernelCapabilityRoutes,
  }
}

/**
 * Domain addresses are injected here—not embedded in the generic client.
 * Replacing a capability implementation or version does not change renderer
 * IPC and does not create a Desktop dependency.
 */
export const DefaultWorkbenchKernelCapabilityRoutes: WorkbenchKernelCapabilityRoutes =
  Object.freeze({
    'agent.execute': { capabilityId: 'velaros.agent', operation: 'execute' },
    'agent.health': { capabilityId: 'velaros.agent', operation: 'health' },
    'agent.abort': {
      capabilityId: 'velaros.workbench.agent-control',
      operation: 'abort',
    },
    'model.configure-profile': {
      capabilityId: 'velaros.workbench.model-profiles',
      operation: 'configure',
    },
    'model.supports-provider': {
      capabilityId: 'velaros.model',
      operation: 'supports_provider',
    },
    'browser.create': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'create',
    },
    'browser.open': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'open',
    },
    'browser.navigate': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'navigate',
    },
    'browser.inspect': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'inspect',
    },
    'browser.input': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'input',
    },
    'browser.selection': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'selection',
    },
    'browser.close-session': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'close',
    },
    'browser.close-all-sessions': {
      capabilityId: 'velaros.workbench.browser-control',
      operation: 'close_all',
    },
  })
