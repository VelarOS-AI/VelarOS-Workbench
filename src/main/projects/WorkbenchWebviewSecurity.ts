import {
  normalizeWorkbenchBrowserPageUrl,
  WorkbenchBrowserPartition,
} from '../../shared/workbenchBrowser'

interface WorkbenchWebviewPreferences {
  preload?: string
  preloadURL?: string
  nodeIntegration?: boolean
  nodeIntegrationInWorker?: boolean
  nodeIntegrationInSubFrames?: boolean
  webviewTag?: boolean
  contextIsolation?: boolean
  sandbox?: boolean
  webSecurity?: boolean
  allowRunningInsecureContent?: boolean
}

interface WorkbenchWebviewParams {
  src?: string
  partition?: string
}

/** Workbench 内嵌页只接收普通网页；本地文件和特权协议不能进入 guest。 */
export function normalizeWorkbenchInternalBrowserUrl(rawUrl: string): string | null {
  return normalizeWorkbenchBrowserPageUrl(rawUrl)
}

/**
 * Electron 在 guest 创建前提供最后一道宿主边界。Renderer 只能请求网页地址，不能借
 * `<webview>` 注入 preload、打开 Node 或关闭同源安全；partition 也固定为 Workbench Browser。
 */
export function prepareWorkbenchWebviewAttachment(
  webPreferences: WorkbenchWebviewPreferences,
  params: WorkbenchWebviewParams
): boolean {
  if (params.partition !== WorkbenchBrowserPartition) return false
  if (!normalizeWorkbenchInternalBrowserUrl(params.src ?? 'about:blank')) return false

  delete webPreferences.preload
  delete webPreferences.preloadURL
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.webviewTag = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  return true
}
