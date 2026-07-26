import type { WorkbenchProjectHubBridge } from './projectHub'
import type { WorkbenchFsBridge } from './workbenchFs'
import type { WorkbenchGitBridge } from './workbenchGit'
import type { WorkbenchKernelBridge } from './workbenchKernel'
import type { WorkbenchLanguageBridge } from './workbenchLanguage'
import type { WorkbenchTerminalBridge } from './workbenchTerminal'
import type { WorkbenchWatchBridge } from './workbenchWatch'
import type { WorkbenchWorkspaceBridge } from './workbenchWorkspace'

declare global {
  interface Window {
    velarosWorkbenchProjectHub: WorkbenchProjectHubBridge
    velarosWorkbenchFs: WorkbenchFsBridge
    velarosWorkbenchGit: WorkbenchGitBridge
    velarosWorkbenchKernel: WorkbenchKernelBridge
    velarosWorkbenchLanguage: WorkbenchLanguageBridge
    velarosWorkbenchTerminal: WorkbenchTerminalBridge
    velarosWorkbenchWatch: WorkbenchWatchBridge
    velarosWorkbenchWorkspace: WorkbenchWorkspaceBridge
  }
}

export {}
