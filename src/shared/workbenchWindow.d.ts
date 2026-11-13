import type { WorkbenchProjectHubBridge } from './projectHub'
import type { WorkbenchAccountBridge } from './workbenchAccount'
import type { WorkbenchAgentProcessesBridge } from './workbenchAgentProcesses'
import type { WorkbenchBrowserBridge } from './workbenchBrowser'
import type { WorkbenchConversationBridge } from './workbenchConversation'
import type { WorkbenchDebuggerBridge } from './workbenchDebugger'
import type { WorkbenchFsBridge } from './workbenchFs'
import type { WorkbenchGitBridge } from './workbenchGit'
import type { WorkbenchLanguageBridge } from './workbenchLanguage'
import type { WorkbenchMemoryBridge } from './workbenchMemory'
import type { WorkbenchModelBridge } from './workbenchModel'
import type { WorkbenchProductAnalyticsBridge } from './workbenchProductAnalytics'
import type { WorkbenchSessionPeersBridge } from './workbenchSessionPeers'
import type { WorkbenchSettingsWindowBridge } from './workbenchSettingsWindow'
import type { WorkbenchTerminalBridge } from './workbenchTerminal'
import type { WorkbenchUpdateBridge } from './workbenchUpdate'
import type { WorkbenchWatchBridge } from './workbenchWatch'
import type { WorkbenchWindowCloseBridge } from './workbenchWindowClose'
import type { WorkbenchWindowStateBridge } from './workbenchWindowState'
import type { WorkbenchWorkspaceBridge } from './workbenchWorkspace'

declare global {
  interface Window {
    velarosWorkbenchSettingsWindow: WorkbenchSettingsWindowBridge
    velarosWorkbenchAccount: WorkbenchAccountBridge
    velarosWorkbenchBrowser: WorkbenchBrowserBridge
    velarosWorkbenchAgentProcesses: WorkbenchAgentProcessesBridge
    velarosWorkbenchSessionPeers: WorkbenchSessionPeersBridge
    velarosWorkbenchConversation: WorkbenchConversationBridge
    velarosWorkbenchDebugger: WorkbenchDebuggerBridge
    velarosWorkbenchProjectHub: WorkbenchProjectHubBridge
    velarosWorkbenchFs: WorkbenchFsBridge
    velarosWorkbenchGit: WorkbenchGitBridge
    velarosWorkbenchLanguage: WorkbenchLanguageBridge
    velarosWorkbenchMemory: WorkbenchMemoryBridge
    velarosWorkbenchModel: WorkbenchModelBridge
    velarosWorkbenchTerminal: WorkbenchTerminalBridge
    velarosWorkbenchWatch: WorkbenchWatchBridge
    velarosWorkbenchWorkspace: WorkbenchWorkspaceBridge
    velarosWorkbenchUpdate: WorkbenchUpdateBridge
    velarosWorkbenchWindowState: WorkbenchWindowStateBridge
    velarosWorkbenchWindowClose: WorkbenchWindowCloseBridge
    velarosWorkbenchProductAnalytics: WorkbenchProductAnalyticsBridge
  }
}

export {}
