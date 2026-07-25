interface WorkbenchGitSurfacesActiveInput {
  activeBottomTool: string
  activeLeftTool: string
  activeWorkbenchChatSessionId: Nullable<string>
  isCommandPanelCollapsed: boolean
}

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
