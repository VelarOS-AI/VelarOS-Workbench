export const WorkbenchAccountChannels = {
  getState: 'workbench-app:account:get-state',
  ensureSignedIn: 'workbench-app:account:ensure-signed-in',
  signIn: 'workbench-app:account:sign-in',
  signOut: 'workbench-app:account:sign-out',
  changed: 'workbench-app:account:changed',
} as const

export interface WorkbenchAccountIdentity {
  readonly id: string
  readonly displayName: string
  readonly email: string
  /** 账号注册来源；官网页面据此留在中文站或国际站。 */
  readonly market?: 'cn' | 'en'
}

export type WorkbenchAccountState =
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly account: WorkbenchAccountIdentity }

export interface WorkbenchAccountBridge {
  getState: () => Promise<WorkbenchAccountState>
  ensureSignedIn: () => Promise<WorkbenchAccountState>
  signIn: () => Promise<WorkbenchAccountState>
  signOut: () => Promise<WorkbenchAccountState>
  onChanged: (listener: (state: WorkbenchAccountState) => void) => () => void
}
