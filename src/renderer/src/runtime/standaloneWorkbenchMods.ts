import { useEffect, useSyncExternalStore } from 'react'

import type { WorkbenchModCatalog, WorkbenchModRecord } from '@shared/workbenchMods'

export interface WorkbenchModCatalogState {
  readonly value: WorkbenchModCatalog | null
  readonly loading: boolean
  readonly error: string | null
}

const BrowserModId = 'velaros.browser' as const
const listeners = new Set<() => void>()

let catalogState: WorkbenchModCatalogState = {
  value: null,
  loading: true,
  error: null,
}
let catalogRequest: Promise<void> | null = null
let bridgeSubscription: (() => void) | null = null
let pendingGeneration = 0

function notifyModListeners(): void {
  for (const listener of listeners) listener()
}

function readModBridge(): typeof window.velarosWorkbenchMods | null {
  if (typeof window === 'undefined') return null
  return window.velarosWorkbenchMods ?? null
}

function applyModCatalog(catalog: WorkbenchModCatalog): void {
  if (catalogState.value && catalog.generation < catalogState.value.generation) return
  catalogState = { value: catalog, loading: false, error: null }
  notifyModListeners()
}

function reportModFailure(error: unknown): void {
  catalogState = {
    ...catalogState,
    loading: false,
    error: error instanceof Error ? error.message : String(error),
  }
  notifyModListeners()
}

function ensureBridgeSubscription(): void {
  if (bridgeSubscription || listeners.size === 0) return
  const bridge = readModBridge()
  if (!bridge) return
  bridgeSubscription = bridge.onChanged((event) => {
    pendingGeneration = Math.max(pendingGeneration, event.generation)
    void refreshWorkbenchModCatalog()
  })
}

function subscribeMods(listener: () => void): () => void {
  listeners.add(listener)
  ensureBridgeSubscription()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      bridgeSubscription?.()
      bridgeSubscription = null
    }
  }
}

export function findWorkbenchBrowserMod(
  catalog: WorkbenchModCatalog | null
): WorkbenchModRecord | null {
  return catalog?.mods.find((mod) => mod.id === BrowserModId) ?? null
}

export function refreshWorkbenchModCatalog(): Promise<void> {
  if (catalogRequest) return catalogRequest
  const bridge = readModBridge()
  if (!bridge) return Promise.resolve()

  catalogState = { ...catalogState, loading: true, error: null }
  notifyModListeners()
  catalogRequest = bridge.listCatalog()
    .then(applyModCatalog)
    .catch(reportModFailure)
    .finally(() => {
      catalogRequest = null
      const loadedGeneration = catalogState.value?.generation ?? 0
      if (pendingGeneration <= loadedGeneration) {
        pendingGeneration = 0
      } else if (pendingGeneration > 0) {
        // 变更通知可能赶在较早的 listCatalog 响应前到达；补取一次最新目录。
        pendingGeneration = 0
        void refreshWorkbenchModCatalog()
      }
    })
  return catalogRequest
}

export async function setWorkbenchBrowserModEnabled(enabled: boolean): Promise<void> {
  const bridge = readModBridge()
  if (!bridge) throw new Error('Workbench Mods are unavailable.')
  try {
    applyModCatalog(await bridge.setEnabled({ id: BrowserModId, enabled }))
  } catch (error) {
    reportModFailure(error)
    throw error
  }
}

export function useStandaloneWorkbenchModCatalog(): WorkbenchModCatalogState {
  const state = useSyncExternalStore(
    subscribeMods,
    () => catalogState,
    () => catalogState
  )
  useEffect(() => {
    void refreshWorkbenchModCatalog()
  }, [])
  return state
}
