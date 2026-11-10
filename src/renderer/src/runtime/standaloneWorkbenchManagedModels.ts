import { useSyncExternalStore } from 'react'

import { AppError } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchManagedModelAccessSnapshot,
  WorkbenchManagedModelProvider,
  WorkbenchManagedModelProviderId,
} from '@shared/workbenchModel'

export type StandaloneWorkbenchManagedModelState =
  | { readonly status: 'loading'; readonly managedModels: readonly [] }
  | {
      readonly status: 'ready'
      readonly managedModels: readonly WorkbenchManagedModelProvider[]
      readonly updatedAt: string
    }
  | { readonly status: 'error'; readonly managedModels: readonly []; readonly error: string }

const InitialState: StandaloneWorkbenchManagedModelState = {
  status: 'loading',
  managedModels: [],
}
interface ManagedModelRequest {
  readonly promise: Promise<WorkbenchManagedModelAccessSnapshot>
}

const listeners = new Set<() => void>()
let currentState: StandaloneWorkbenchManagedModelState = InitialState
let activeRequest: ManagedModelRequest | null = null
let stopWatching: (() => void) | null = null

function publish(state: StandaloneWorkbenchManagedModelState): void {
  currentState = state
  for (const listener of listeners) listener()
}

function releaseWatchingIfIdle(): void {
  if (listeners.size > 0 || activeRequest || !stopWatching) return
  const stop = stopWatching
  stopWatching = null
  stop()
}

function refreshOnFocus(): void {
  void refreshStandaloneWorkbenchManagedModels().catch(() => undefined)
}

function ensureWatching(): boolean {
  if (stopWatching) return false
  const target = window
  const stopAccount = target.velarosWorkbenchAccount.onChanged(state => {
    activeRequest = null
    publish(state.status === 'signed-out'
      ? { status: 'ready', managedModels: [], updatedAt: new Date().toISOString() }
      : InitialState)
    if (state.status === 'signed-in' && listeners.size > 0) refreshOnFocus()
    releaseWatchingIfIdle()
  })
  stopWatching = () => {
    stopAccount()
    target.removeEventListener('focus', refreshOnFocus)
  }
  target.addEventListener('focus', refreshOnFocus)
  return true
}

export function refreshStandaloneWorkbenchManagedModels(): Promise<
  WorkbenchManagedModelAccessSnapshot
> {
  if (activeRequest) return activeRequest.promise
  if (typeof window === 'undefined' || !window.velarosWorkbenchModel)
    return Promise.resolve({ managedModels: [], updatedAt: new Date(0).toISOString() })

  const result = Promise.withResolvers<WorkbenchManagedModelAccessSnapshot>()
  const request: ManagedModelRequest = {
    promise: result.promise
      .then(snapshot => {
        if (activeRequest !== request)
          throw new AppError('CANCELLED', 'Managed model authorization changed.')
        publish({
          status: 'ready',
          managedModels: snapshot.managedModels,
          updatedAt: snapshot.updatedAt,
        })
        return snapshot
      })
      .catch((error: unknown) => {
        if (activeRequest === request) {
          publish({
            status: 'error',
            managedModels: [],
            error: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      })
      .finally(() => {
        if (activeRequest === request) activeRequest = null
        releaseWatchingIfIdle()
      }),
  }
  activeRequest = request
  try {
    const newScope = ensureWatching()
    // 同一账号的普通刷新保留成功快照；重新接入账号监听时不信任空档中的旧授权。
    if ((newScope || currentState.status !== 'ready') && currentState !== InitialState)
      publish(InitialState)
    if (activeRequest !== request)
      throw new AppError('CANCELLED', 'Managed model authorization changed.')
    void window.velarosWorkbenchModel.listManagedProviders().then(result.resolve, result.reject)
  } catch (error) {
    result.reject(error)
  }
  return request.promise
}

export function getStandaloneWorkbenchManagedModelState(): StandaloneWorkbenchManagedModelState {
  return currentState
}

export function getStandaloneWorkbenchManagedProvider(
  providerId: string,
  state: StandaloneWorkbenchManagedModelState = currentState
): WorkbenchManagedModelProvider | undefined {
  return state.managedModels.find((provider) => provider.providerId === providerId)
}

export function isStandaloneWorkbenchManagedProviderId(
  providerId: string
): providerId is WorkbenchManagedModelProviderId {
  return providerId === 'velaros' || providerId === 'velar-dev'
}

export function isStandaloneWorkbenchModelProviderSelectable(providerId: string): boolean {
  return !isStandaloneWorkbenchManagedProviderId(providerId)
    || getStandaloneWorkbenchManagedProvider(providerId)?.enabled === true
}

export function subscribeStandaloneWorkbenchManagedModels(listener: () => void): () => void {
  const first = listeners.size === 0
  listeners.add(listener)
  if (first) refreshOnFocus()
  return () => {
    listeners.delete(listener)
    releaseWatchingIfIdle()
  }
}

export function useStandaloneWorkbenchManagedModels(): StandaloneWorkbenchManagedModelState {
  return useSyncExternalStore(
    subscribeStandaloneWorkbenchManagedModels,
    () => stopWatching ? currentState : InitialState,
    () => InitialState
  )
}
