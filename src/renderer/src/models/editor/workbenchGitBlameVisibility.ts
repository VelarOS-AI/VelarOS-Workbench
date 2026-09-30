/**
 * Git 追溯栏开没开。这次运行里所有文件共用一个开关：开着就一直开着，换文件时查新文件的；不存进偏好，
 * 重开应用是关着的。编辑器右键菜单与命令面板切的是同一个。
 */
let visible = false
const listeners = new Set<() => void>()

export function isWorkbenchGitBlameVisible(): boolean {
  return visible
}

export function toggleWorkbenchGitBlameVisible(): void {
  visible = !visible
  for (const listener of listeners) listener()
}

export function subscribeWorkbenchGitBlameVisible(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
