import type { Session, WebContents } from 'electron'

import { normalizeWorkbenchBrowserPageUrl } from '../../shared/workbenchBrowser'

type PermissionCheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
type PermissionRequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type DevicePermissionHandler = NonNullable<Parameters<Session['setDevicePermissionHandler']>[0]>

type WorkbenchBrowserPermissionSession = Pick<
  Session,
  'setDevicePermissionHandler' | 'setPermissionCheckHandler' | 'setPermissionRequestHandler'
>

const denyDevicePermission: DevicePermissionHandler = () => false

interface WorkbenchBrowserPermissionOptions {
  isInteractiveGuest: (webContents: WebContents) => boolean
}

interface PermissionPolicyState {
  delegate: PermissionRequestHandler | null
  installed: boolean
  isInteractiveGuest: WorkbenchBrowserPermissionOptions['isInteractiveGuest']
  readonly check: PermissionCheckHandler
  readonly gateway: PermissionRequestHandler
}

const permissionPolicies = new WeakMap<object, PermissionPolicyState>()

function allowsInteractivePointerLock(
  state: PermissionPolicyState,
  webContents: WebContents | null,
  requestingUrl: string
): boolean {
  try {
    if (!webContents || webContents.isDestroyed() || !state.isInteractiveGuest(webContents)) return false
    const pageUrl = normalizeWorkbenchBrowserPageUrl(webContents.getURL(), { allowAboutBlank: false })
    const requestUrl = normalizeWorkbenchBrowserPageUrl(requestingUrl, { allowAboutBlank: false })
    return !!pageUrl && !!requestUrl && new URL(pageUrl).origin === new URL(requestUrl).origin
  } catch {
    // 页面销毁或导航期间无法确认归属时，拒绝本次请求。
    return false
  }
}

function getOrCreatePolicyState(
  electronSession: WorkbenchBrowserPermissionSession
): PermissionPolicyState {
  const current = permissionPolicies.get(electronSession)
  if (current) return current

  const state: PermissionPolicyState = {
    delegate: null,
    installed: false,
    isInteractiveGuest: () => false,
    check: (webContents, permission, requestingOrigin, details) =>
      permission === 'pointerLock'
      && allowsInteractivePointerLock(state, webContents, requestingOrigin)
      && (details.requestingUrl === undefined
        || allowsInteractivePointerLock(state, webContents, details.requestingUrl)),
    gateway: (webContents, permission, callback, details) => {
      if (permission === 'pointerLock') {
        // 人工预览与已呈现的 Agent 页面共用交互策略；用户手势约束和 Esc 释放由 Chromium 执行。
        callback(allowsInteractivePointerLock(state, webContents, details.requestingUrl))
        return
      }
      const delegate = state.delegate
      if (!delegate) {
        callback(false)
        return
      }

      let settled = false
      const settle = (granted: boolean): void => {
        if (settled) return
        settled = true
        callback(granted === true)
      }
      try {
        delegate(webContents, permission, settle, details)
      } catch {
        settle(false)
      }
    },
  }
  permissionPolicies.set(electronSession, state)
  return state
}

function applyStableGateway(
  electronSession: WorkbenchBrowserPermissionSession,
  state: PermissionPolicyState
): void {
  if (state.installed) return
  electronSession.setPermissionCheckHandler(state.check)
  electronSession.setDevicePermissionHandler(denyDevicePermission)
  electronSession.setPermissionRequestHandler(state.gateway)
  state.installed = true
}

/**
 * Browser partition 创建后立即安装。已由宿主验证的交互页面可使用指针锁定，
 * 其余权限沿用默认拒绝与 runtime 授权链，不受人工页是否接入 Agent 会话影响。
 */
export function installWorkbenchBrowserDefaultPermissionPolicy(
  electronSession: WorkbenchBrowserPermissionSession,
  options?: WorkbenchBrowserPermissionOptions
): () => void {
  const state = getOrCreatePolicyState(electronSession)
  if (options) state.isInteractiveGuest = options.isInteractiveGuest
  applyStableGateway(electronSession, state)
  // Electron Session 与应用同寿命；清理函数故意不撤掉 fail-closed gateway。
  return () => undefined
}

/**
 * Runtime 接管页面时临时安装 pending-event handler。注销只移除该委托，
 * 交互页面的指针锁定仍由稳定 gateway 处理。
 */
export function registerWorkbenchBrowserRuntimePermissionHandler(
  electronSession: WorkbenchBrowserPermissionSession,
  handler: PermissionRequestHandler
): () => void {
  const state = getOrCreatePolicyState(electronSession)
  applyStableGateway(electronSession, state)
  state.delegate = handler

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (state.delegate === handler) state.delegate = null
  }
}

export type { WorkbenchBrowserPermissionSession }
