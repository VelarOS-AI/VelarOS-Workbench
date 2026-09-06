import { useEffect, useSyncExternalStore } from 'react'

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
const listeners = new Set<() => void>()
let currentState: StandaloneWorkbenchManagedModelState = InitialState
let activeRequest: Promise<WorkbenchManagedModelAccessSnapshot> | null = null
let hydrationStarted = false

function publish(state: StandaloneWorkbenchManagedModelState): void {
  currentState = state
  for (const listener of listeners) listener()
}

export async function refreshStandaloneWorkbenchManagedModels(): Promise<
  WorkbenchManagedModelAccessSnapshot
> {
  if (activeRequest) return activeRequest
  if (typeof window === 'undefined' || !window.velarosWorkbenchModel) return { managedModels: [], updatedAt: new Date(0).toISOString() }

  // 刷新期间继续展示最后一次成功快照，避免已打开的模型选择短暂消失。
  if (currentState.status !== 'ready') publish(InitialState)
  const request = window.velarosWorkbenchModel.listManagedProviders()
  activeRequest = request
  try {
    const snapshot = await request
    if (activeRequest === request) {
      publish({
        status: 'ready',
        managedModels: snapshot.managedModels,
        updatedAt: snapshot.updatedAt,
      })
    }
    return snapshot
  } catch (error) {
    if (activeRequest === request) {
      publish({
        status: 'error',
        managedModels: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    if (activeRequest === request) activeRequest = null
  }
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
  return providerId === 'velar' || providerId === 'velar-dev'
}

export function isStandaloneWorkbenchModelProviderSelectable(providerId: string): boolean {
  return !isStandaloneWorkbenchManagedProviderId(providerId)
    || getStandaloneWorkbenchManagedProvider(providerId)?.enabled === true
}

export function subscribeStandaloneWorkbenchManagedModels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStandaloneWorkbenchManagedModels(): StandaloneWorkbenchManagedModelState {
  useEffect(() => {
    if (!hydrationStarted) {
      hydrationStarted = true
      void refreshStandaloneWorkbenchManagedModels().catch(() => undefined)
    }
    const disposeAccount = window.velarosWorkbenchAccount.onChanged((state) => {
      if (state.status === 'signed-out') {
        activeRequest = null
        publish({ status: 'ready', managedModels: [], updatedAt: new Date().toISOString() })
        return
      }
      void refreshStandaloneWorkbenchManagedModels().catch(() => undefined)
    })
    const refreshOnFocus = (): void => {
      void refreshStandaloneWorkbenchManagedModels().catch(() => undefined)
    }
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      disposeAccount()
      window.removeEventListener('focus', refreshOnFocus)
    }
  }, [])

  return useSyncExternalStore(
    subscribeStandaloneWorkbenchManagedModels,
    () => currentState,
    () => InitialState
  )
}
