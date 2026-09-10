import { useEffect, useSyncExternalStore } from 'react'

import type { ModelPricingCatalog } from '@velaros-ai/model/contracts'

/**
 * 公开模型价格目录（Desktop ModelPricingProvider 的对位件）：共享会话 UI 拿它和当前模型估算每条
 * 回答的约价。整个窗口共用一份，第一次有会话面挂出来时去取；取不到就不显示约价，下次挂出来再试。
 */
let catalog: ModelPricingCatalog | null = null
let request: Promise<void> | null = null
const listeners = new Set<() => void>()

function requestCatalog(): void {
  if (request || catalog) return
  request = window.velarosWorkbenchAccount
    .getModelPricing()
    .catch(() => null)
    .then((next) => {
      catalog = next
      request = null
      for (const listener of listeners) listener()
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function readCatalog(): ModelPricingCatalog | null {
  return catalog
}

export function useStandaloneModelPricing(): ModelPricingCatalog | null {
  useEffect(requestCatalog, [])
  return useSyncExternalStore(subscribe, readCatalog, readCatalog)
}
