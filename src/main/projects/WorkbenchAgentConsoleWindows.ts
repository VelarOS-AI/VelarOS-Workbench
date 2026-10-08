import type { BrowserWindow } from 'electron'

/** 每个项目窗口持有一个控制台子窗；关闭所属窗口时一并释放。 */
export class WorkbenchAgentConsoleWindows {
  private readonly windows = new Map<number, BrowserWindow>()

  public register(ownerId: number, window: BrowserWindow): void {
    this.windows.set(ownerId, window)
    window.once('closed', () => {
      if (this.windows.get(ownerId) === window) this.windows.delete(ownerId)
    })
  }

  public releaseOwner(ownerId: number): void {
    const window = this.windows.get(ownerId)
    this.windows.delete(ownerId)
    if (window && !window.isDestroyed()) window.close()
  }

  public focus(ownerId: number): boolean {
    const window = this.windows.get(ownerId)
    if (!window || window.isDestroyed()) {
      this.windows.delete(ownerId)
      return false
    }
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    return true
  }
}
