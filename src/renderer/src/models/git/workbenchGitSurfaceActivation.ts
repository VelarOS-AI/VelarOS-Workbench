interface WorkbenchGitSurfacesActiveInput {
  activeBottomTool: string
  activeLeftTool: string
  activeWorkbenchChatSessionId: Nullable<string>
  isCommandPanelCollapsed: boolean
}

/**
 * Git 界面开着没有：开着时完整快照跟工作区改动走顶栏的节奏；没开时也跟（文件树的 Git 颜色靠它），
 * 只是放慢（见 useWorkbenchGitState）。
 */
export function resolveWorkbenchGitSurfacesActive({
  activeBottomTool,
  activeLeftTool,
  activeWorkbenchChatSessionId,
  isCommandPanelCollapsed,
}: WorkbenchGitSurfacesActiveInput): boolean {
  return (
    activeLeftTool === 'commit' ||
    (!isCommandPanelCollapsed && activeBottomTool === 'git') ||
    !!activeWorkbenchChatSessionId
  )
}
