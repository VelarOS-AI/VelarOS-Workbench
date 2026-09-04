import type { Session } from 'electron'

type PermissionCheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
type PermissionRequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type DevicePermissionHandler = NonNullable<Parameters<Session['setDevicePermissionHandler']>[0]>

type WorkbenchBrowserPermissionSession = Pick<
  Session,
  'setDevicePermissionHandler' | 'setPermissionCheckHandler' | 'setPermissionRequestHandler'
>

const denyPermissionCheck: PermissionCheckHandler = () => false
const denyDevicePermission: DevicePermissionHandler = () => false

interface PermissionPolicyState {
  delegate: PermissionRequestHandler | null
  installed: boolean
  readonly gateway: PermissionRequestHandler
}

const permissionPolicies = new WeakMap<object, PermissionPolicyState>()

function getOrCreatePolicyState(
  electronSession: WorkbenchBrowserPermissionSession
): PermissionPolicyState {
  const current = permissionPolicies.get(electronSession)
  if (current) return current

  const state: PermissionPolicyState = {
    delegate: null,
    installed: false,
    gateway: (webContents, permission, callback, details) => {
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
  electronSession.setPermissionCheckHandler(denyPermissionCheck)
  electronSession.setDevicePermissionHandler(denyDevicePermission)
  electronSession.setPermissionRequestHandler(state.gateway)
  state.installed = true
}

/**
 * 在 Browser partition 创建后立即安装。这样人工 debug webview 尚未交给 runtime 前，
 * Chromium 权限检查和请求也都会关闭失败。
 */
export function installWorkbenchBrowserDefaultPermissionPolicy(
  electronSession: WorkbenchBrowserPermissionSession
): () => void {
  const state = getOrCreatePolicyState(electronSession)
  applyStableGateway(electronSession, state)
  // Electron Session 与应用同寿命；清理函数故意不撤掉 fail-closed gateway。
  return () => undefined
}

/**
 * Runtime 接管页面时临时安装 pending-event handler。注销后恢复默认拒绝，而不是留下
 * Electron 的默认权限行为。
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
