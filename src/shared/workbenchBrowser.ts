import type { WorkbenchFsCallResult } from './workbenchFs'

/** Persistent Electron partition for the Workbench debug browser views. */
export const WorkbenchBrowserPartition = 'persist:velaros-workbench-browser'

/**
 * Agent 浏览器（Platform 的 velaros:browser）：每个聊天会话一个受控页面，界面在编辑区的「浏览器」标签里把
 * webview 交给主进程的浏览器运行时接管，导航也经运行时走，界面不自己 loadURL。
 */
export const WorkbenchBrowserChannels = {
  getState: 'workbench-app:browser:get-state',
  attachPage: 'workbench-app:browser:attach-page',
  detachPage: 'workbench-app:browser:detach-page',
  navigate: 'workbench-app:browser:navigate',
  leaveSite: 'workbench-app:browser:leave-site',
  changed: 'workbench-app:browser:changed',
} as const

/** 窗口只能动自己当前打开的项目里、这个聊天会话的浏览器。 */
export interface WorkbenchBrowserSessionRequest {
  projectRoot: string
  sessionId: string
}

export interface WorkbenchBrowserAttachRequest extends WorkbenchBrowserSessionRequest {
  /** 这个窗口里那个 webview 的 guest WebContents id。 */
  webContentsId: number
}

export type WorkbenchBrowserNavigationAction = 'goto' | 'back' | 'forward' | 'reload'

export interface WorkbenchBrowserNavigateRequest extends WorkbenchBrowserSessionRequest {
  action: WorkbenchBrowserNavigationAction
  /** `goto` 的地址（地址栏里的原文：不像网址的按搜索词处理）。 */
  url?: string
}

/** 会话的浏览器此刻进的站点；没进为 null（标签随之收起）。 */
export interface WorkbenchBrowserState extends WorkbenchBrowserSessionRequest {
  site: Nullable<{ url: string }>
}

export interface WorkbenchBrowserBridge {
  getState(request: WorkbenchBrowserSessionRequest): Promise<WorkbenchFsCallResult<WorkbenchBrowserState>>
  attachPage(request: WorkbenchBrowserAttachRequest): Promise<WorkbenchFsCallResult<void>>
  detachPage(request: WorkbenchBrowserSessionRequest): Promise<WorkbenchFsCallResult<void>>
  navigate(request: WorkbenchBrowserNavigateRequest): Promise<WorkbenchFsCallResult<void>>
  leaveSite(request: WorkbenchBrowserSessionRequest): Promise<WorkbenchFsCallResult<void>>
  /** 站点变了（Agent 进出站点、页面自己跳走）：只推给这个会话所在项目的窗口。 */
  onChanged(listener: (state: WorkbenchBrowserState) => void): () => void
}

/**
 * 网上查资料（`velaros:web`）的无头页面用的分区：持久（搜索引擎的同意页、地区设置留着），跟内置浏览器的
 * 登录态分开。
 */
export const WorkbenchWebSearchPartition = 'persist:velaros-workbench-web'

/**
 * Workbench Browser 的最终加载边界。地址栏可以先把搜索词展开为 URL，但在任何
 * `loadURL` / runtime 导航前都必须再经过这里，避免 `file:` 或特权协议进入 guest。
 */
export function normalizeWorkbenchBrowserPageUrl(
  rawUrl: string,
  options: { allowAboutBlank?: boolean } = {}
): string | null {
  if (typeof rawUrl !== 'string' || containsControlCharacter(rawUrl)) return null
  const candidate = rawUrl.trim()
  if (!candidate) return null
  if (candidate === 'about:blank') return options.allowAboutBlank === false ? null : candidate

  try {
    const url = new URL(candidate)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}
