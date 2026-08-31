import type { WorkbenchProjectHubBridge } from './projectHub'
import type { WorkbenchAccountBridge } from './workbenchAccount'
import type { WorkbenchFsBridge } from './workbenchFs'
import type { WorkbenchGitBridge } from './workbenchGit'
import type { WorkbenchKernelBridge } from './workbenchKernel'
import type { WorkbenchLanguageBridge } from './workbenchLanguage'
import type { WorkbenchModelBridge } from './workbenchModel'
import type { WorkbenchProductAnalyticsBridge } from './workbenchProductAnalytics'
import type { WorkbenchResourcePluginBridge } from './workbenchResourcePlugins'
import type { WorkbenchTerminalBridge } from './workbenchTerminal'
import type { WorkbenchUpdateBridge } from './workbenchUpdate'
import type { WorkbenchWatchBridge } from './workbenchWatch'
import type { WorkbenchWorkspaceBridge } from './workbenchWorkspace'

declare global {
  interface Window {
    velarosWorkbenchAccount: WorkbenchAccountBridge
    velarosWorkbenchProjectHub: WorkbenchProjectHubBridge
    velarosWorkbenchFs: WorkbenchFsBridge
    velarosWorkbenchGit: WorkbenchGitBridge
    velarosWorkbenchKernel: WorkbenchKernelBridge
    velarosWorkbenchLanguage: WorkbenchLanguageBridge
    velarosWorkbenchModel: WorkbenchModelBridge
    velarosWorkbenchTerminal: WorkbenchTerminalBridge
    velarosWorkbenchWatch: WorkbenchWatchBridge
    velarosWorkbenchWorkspace: WorkbenchWorkspaceBridge
    velarosWorkbenchResourcePlugins: WorkbenchResourcePluginBridge
    velarosWorkbenchUpdate: WorkbenchUpdateBridge
    velarosWorkbenchProductAnalytics: WorkbenchProductAnalyticsBridge
  }
}

export {}
