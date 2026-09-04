/** Persistent Electron partition shared by manual and Agent-controlled Workbench browser views. */
export const WorkbenchBrowserPartition = 'persist:velaros-workbench-browser'

/**
 * Browser IPC 只负责把 Agent 已建立的站点会话接到当前窗口自己的 webview。
 * renderer 不传 projectRoot；main 从 IPC sender 对应的项目窗口推导，避免跨窗口冒认工程。
 */
export const WorkbenchBrowserChannels = {
  getState: 'workbench-app:browser:get-state',
  presentPage: 'workbench-app:browser:present-page',
  closeSession: 'workbench-app:browser:close-session',
  changed: 'workbench-app:browser:changed',
} as const

export type WorkbenchBrowserLoadState = 'loaded' | 'error' | 'unknown'

export interface WorkbenchBrowserState {
  generation: number
  sessionId: string
  active: boolean
  url: string | null
  title: string | null
  loadState: WorkbenchBrowserLoadState
  visible: boolean
}

export interface WorkbenchBrowserStateRequest {
  sessionId: string
}

export interface WorkbenchBrowserPresentPageRequest {
  sessionId: string
  /** Electron webview guest 的 WebContents id；main 会校验其 hostWebContents。 */
  webContentsId: number
}

export interface WorkbenchBrowserCloseSessionRequest {
  sessionId: string
}

/** 事件不泄露会话 id；各窗口只按自己持有的 sessionId 重取状态。 */
export interface WorkbenchBrowserChangedEvent {
  generation: number
}

export interface WorkbenchBrowserBridge {
  getState: (request: WorkbenchBrowserStateRequest) => Promise<WorkbenchBrowserState>
  presentPage: (
    request: WorkbenchBrowserPresentPageRequest
  ) => Promise<WorkbenchBrowserState>
  closeSession: (request: WorkbenchBrowserCloseSessionRequest) => Promise<void>
  onChanged: (listener: (event: WorkbenchBrowserChangedEvent) => void) => () => void
}

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
