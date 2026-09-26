interface WorkbenchBrowserGuest {
  isDestroyed(): boolean
  close(options?: { waitForBeforeUnload?: boolean }): void
  once(event: 'destroyed', listener: () => void): unknown
}

/**
 * 界面里调试浏览器（用户自己开的网页标签）对 Electron guest 的主进程闸门。
 *
 * 只认经它登记过的 guest：权限策略据此判断请求是不是来自用户正在交互的调试页；应用退出（闸门释放）后
 * 拒绝新的 attach，并销毁此前挂上来的 guest。
 */
export class WorkbenchBrowserWebviewGate {
  private readonly guests = new Set<WorkbenchBrowserGuest>()
  private disposed = false

  public allowsAttachment(): boolean {
    return !this.disposed
  }

  public ownsGuest(guest: WorkbenchBrowserGuest): boolean {
    return !this.disposed && this.guests.has(guest) && !guest.isDestroyed()
  }

  /** 返回 false 表示 attach 与闸门释放发生竞态，调用方不应再配置该 guest。 */
  public track(guest: WorkbenchBrowserGuest): boolean {
    if (this.disposed || guest.isDestroyed()) {
      closeGuest(guest)
      return false
    }
    if (this.guests.has(guest)) return true

    this.guests.add(guest)
    guest.once('destroyed', () => this.guests.delete(guest))
    return true
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const guests = [...this.guests]
    this.guests.clear()
    for (const guest of guests) closeGuest(guest)
  }
}

function closeGuest(guest: WorkbenchBrowserGuest): void {
  if (guest.isDestroyed()) return
  try {
    guest.close({ waitForBeforeUnload: false })
  } catch {
    // guest 可能已由 renderer 卸载；销毁路径天然幂等。
  }
}

export type { WorkbenchBrowserGuest }
