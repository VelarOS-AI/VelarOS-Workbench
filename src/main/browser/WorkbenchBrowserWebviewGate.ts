import type { WorkbenchModId } from '../../shared/workbenchMods'

interface WorkbenchBrowserWebviewModState {
  isEnabled(id: WorkbenchModId): boolean
  subscribe(listener: () => void): () => void
}

interface WorkbenchBrowserGuest {
  isDestroyed(): boolean
  close(options?: { waitForBeforeUnload?: boolean }): void
  once(event: 'destroyed', listener: () => void): unknown
}

/**
 * Browser Mod 对 Electron guest 的主进程权威闸门。
 *
 * Renderer 的条件渲染只负责体验；这里同时拒绝禁用后的新 attach，并立即销毁此前挂载的
 * guest，避免 renderer 卡住或被篡改时仍保留浏览器能力。
 */
export class WorkbenchBrowserWebviewGate {
  private readonly guests = new Set<WorkbenchBrowserGuest>()
  private readonly unsubscribe: () => void
  private disposed = false

  public constructor(private readonly modState: WorkbenchBrowserWebviewModState) {
    this.unsubscribe = modState.subscribe(() => {
      if (!this.isEnabled()) this.closeAllGuests()
    })
  }

  public allowsAttachment(): boolean {
    return this.isEnabled()
  }

  /** 返回 false 表示 attach 与 Mod 状态发生竞态，调用方不应再配置该 guest。 */
  public track(guest: WorkbenchBrowserGuest): boolean {
    if (!this.isEnabled() || guest.isDestroyed()) {
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
    this.unsubscribe()
    this.closeAllGuests()
  }

  private isEnabled(): boolean {
    return !this.disposed && this.modState.isEnabled('velaros.browser')
  }

  private closeAllGuests(): void {
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
    // guest 可能在 Mod 通知与 close 之间已由 renderer 卸载；销毁路径天然幂等。
  }
}

export type { WorkbenchBrowserGuest, WorkbenchBrowserWebviewModState }
