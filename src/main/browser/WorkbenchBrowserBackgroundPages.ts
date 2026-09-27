import { BrowserWindow, type WebContents } from 'electron'

import {
  normalizeWorkbenchBrowserPageUrl,
  WorkbenchBrowserPartition,
} from '../../shared/workbenchBrowser'

/** 后台页面的窗口尺寸：按常见桌面宽度排版，模型看到的布局与编辑区里的一致。 */
const BackgroundPageSize = { width: 1280, height: 800 } as const

export interface WorkbenchBrowserBackgroundPagesApi {
  /** 给浏览器会话开一个空白页面；已经有了就给那一个。 */
  open(runtimeSessionId: string): WebContents
  /** 关掉会话的后台页面；没有就什么都不做。 */
  close(runtimeSessionId: string): void
  closeAll(): void
}

/**
 * 浏览器会话的后台页面（移植自 Desktop）：编辑区没挂着这个会话的网页、这一轮运行又要用网页时，主进程开一个
 * 不显示的窗口。与编辑区的 webview 同一个分区（登录态共用）、同样的沙箱；不节流，隐藏着也照常渲染，截图和
 * 点击都能用。一个会话最多一个；用 destroy 关，页面的 beforeunload 拦不住。
 */
export class WorkbenchBrowserBackgroundPages implements WorkbenchBrowserBackgroundPagesApi {
  private readonly windows = new Map<string, BrowserWindow>()

  public open(runtimeSessionId: string): WebContents {
    const existing = this.windows.get(runtimeSessionId)
    if (existing && !existing.isDestroyed()) return existing.webContents

    const window = new BrowserWindow({
      ...BackgroundPageSize,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        partition: WorkbenchBrowserPartition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        backgroundThrottling: false,
      },
    })
    // 与编辑区的 webview 同一道导航边界：只去 http 与 https。
    window.webContents.on('will-navigate', (event, url) => {
      if (!normalizeWorkbenchBrowserPageUrl(url, { allowAboutBlank: false })) event.preventDefault()
    })
    this.windows.set(runtimeSessionId, window)
    window.on('closed', () => {
      if (this.windows.get(runtimeSessionId) === window) this.windows.delete(runtimeSessionId)
    })
    return window.webContents
  }

  public close(runtimeSessionId: string): void {
    const window = this.windows.get(runtimeSessionId)
    this.windows.delete(runtimeSessionId)
    if (window && !window.isDestroyed()) window.destroy()
  }

  public closeAll(): void {
    for (const runtimeSessionId of [...this.windows.keys()]) this.close(runtimeSessionId)
  }
}
