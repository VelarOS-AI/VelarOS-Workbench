/** Desktop 与独立 Workbench 都用同一显式 scope 申请产品私有会话。 */
export interface WorkbenchChatSurfaceScope {
  surface: 'workbench'
  projectRoot: string
}

export function createWorkbenchChatSurfaceScope(projectRoot: string): WorkbenchChatSurfaceScope {
  return {
    surface: 'workbench',
    projectRoot: projectRoot.trim(),
  }
}
