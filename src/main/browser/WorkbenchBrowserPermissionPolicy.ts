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
    installed: false,
    isInteractiveGuest: () => false,
    check: (webContents, permission, requestingOrigin, details) =>
      permission === 'pointerLock'
      && allowsInteractivePointerLock(state, webContents, requestingOrigin)
      && (details.requestingUrl === undefined
        || allowsInteractivePointerLock(state, webContents, details.requestingUrl)),
    // 调试页只放行指针锁定（用户手势约束和 Esc 释放由 Chromium 执行），其余权限一律拒绝。
    gateway: (webContents, permission, callback, details) => {
      callback(
        permission === 'pointerLock'
        && allowsInteractivePointerLock(state, webContents, details.requestingUrl)
      )
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
 * Browser partition 创建后立即安装。已由宿主验证的交互页面可使用指针锁定，其余权限默认拒绝。
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

export type { WorkbenchBrowserPermissionSession }
