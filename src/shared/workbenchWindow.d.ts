import type { WorkbenchProjectHubBridge } from './projectHub'
import type { WorkbenchAccountBridge } from './workbenchAccount'
import type { WorkbenchConversationBridge } from './workbenchConversation'
import type { WorkbenchFsBridge } from './workbenchFs'
import type { WorkbenchGitBridge } from './workbenchGit'
import type { WorkbenchLanguageBridge } from './workbenchLanguage'
import type { WorkbenchModelBridge } from './workbenchModel'
import type { WorkbenchProductAnalyticsBridge } from './workbenchProductAnalytics'
import type { WorkbenchTerminalBridge } from './workbenchTerminal'
import type { WorkbenchUpdateBridge } from './workbenchUpdate'
import type { WorkbenchWatchBridge } from './workbenchWatch'
import type { WorkbenchWindowStateBridge } from './workbenchWindowState'
import type { WorkbenchWorkspaceBridge } from './workbenchWorkspace'

declare global {
  interface Window {
    velarosWorkbenchAccount: WorkbenchAccountBridge
    velarosWorkbenchConversation: WorkbenchConversationBridge
    velarosWorkbenchProjectHub: WorkbenchProjectHubBridge
    velarosWorkbenchFs: WorkbenchFsBridge
    velarosWorkbenchGit: WorkbenchGitBridge
    velarosWorkbenchLanguage: WorkbenchLanguageBridge
    velarosWorkbenchModel: WorkbenchModelBridge
    velarosWorkbenchTerminal: WorkbenchTerminalBridge
    velarosWorkbenchWatch: WorkbenchWatchBridge
    velarosWorkbenchWorkspace: WorkbenchWorkspaceBridge
    velarosWorkbenchUpdate: WorkbenchUpdateBridge
    velarosWorkbenchWindowState: WorkbenchWindowStateBridge
    velarosWorkbenchProductAnalytics: WorkbenchProductAnalyticsBridge
  }
}

export {}
