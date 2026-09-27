import { useEffect, useSyncExternalStore } from 'react'

import { isNonBlankString, isPlainObject, Log } from '@velaros-ai/core'

import {
  type WorkbenchAgentEngineId,
  WorkbenchAgentEngineIds,
  type WorkbenchAgentEngineStatus,
  type WorkbenchConversationEngineSelection,
} from '@shared/workbenchConversation'

const log = Log.tag('workbench-agent-engines')

/** 新建会话默认交给谁：上一次在模型菜单里选的（外部引擎或 VelarOS 自己的 Agent）。 */
const PreferredEngineStorageKey = 'velaros-workbench-app:chat-engine'
/** 引擎情况过了这么久，窗口回到前台时重新问一次（装好、登录之后不用重启）。 */
const StatusRefreshMs = 60_000

const EngineLabels: Readonly<Record<WorkbenchAgentEngineId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

const listeners = new Set<() => void>()
let statuses: readonly WorkbenchAgentEngineStatus[] = []
let loadedAt = 0
let loading: Nullable<Promise<void>> = null

export function workbenchAgentEngineLabel(id: WorkbenchAgentEngineId): string {
  return EngineLabels[id]
}

export function isWorkbenchAgentEngineId(value: unknown): value is WorkbenchAgentEngineId {
  return WorkbenchAgentEngineIds.includes(value as WorkbenchAgentEngineId)
}

/** 会话记着的引擎选择；形状不对的当作 VelarOS 自己的 Agent。 */
export function readWorkbenchEngineSelection(
  value: unknown
): Nullable<WorkbenchConversationEngineSelection> {
  if (!isPlainObject(value) || !isWorkbenchAgentEngineId(value.id)) return null
  return isNonBlankString(value.model) ? { id: value.id, model: value.model } : { id: value.id }
}

export function readPreferredWorkbenchEngine(): Nullable<WorkbenchConversationEngineSelection> {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PreferredEngineStorageKey)
    return raw ? readWorkbenchEngineSelection(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function storePreferredWorkbenchEngine(
  selection: Nullable<WorkbenchConversationEngineSelection>
): void {
  if (typeof window === 'undefined') return
  try {
    if (selection) window.localStorage.setItem(PreferredEngineStorageKey, JSON.stringify(selection))
    else window.localStorage.removeItem(PreferredEngineStorageKey)
  } catch {
    // 只是新会话的默认值，存不下不影响当前会话。
  }
}

/** 这一轮用引擎的哪个模型：会话里选过的，否则引擎报的默认模型；都没有就交给引擎自己定。 */
export function resolveWorkbenchEngineModel(
  selection: WorkbenchConversationEngineSelection,
  status: WorkbenchAgentEngineStatus | undefined
): string | undefined {
  if (selection.model) return selection.model
  return (status?.models.find((model) => model.isDefault) ?? status?.models[0])?.value
}

/** 重新问一次主进程引擎的情况（force 时主进程也重探，不用它的缓存）。 */
export function refreshWorkbenchAgentEngines(force = false): Promise<void> {
  if (typeof window === 'undefined' || !window.velarosWorkbenchConversation) return Promise.resolve()
  loading ??= window.velarosWorkbenchConversation
    .engines({ refresh: force })
    .then((result) => {
      if (!result.ok) {
        log.warn('读不到外部引擎的情况', { message: result.message })
        return
      }
      statuses = result.value
      loadedAt = Date.now()
      for (const listener of listeners) listener()
    })
    .catch((error: unknown) => log.warn('外部引擎通道不可用', { error }))
    .finally(() => {
      loading = null
    })
  return loading
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function refreshWhenStale(): void {
  if (Date.now() - loadedAt >= StatusRefreshMs) void refreshWorkbenchAgentEngines()
}

/** 外部引擎在本机的情况：第一次用到时问，窗口回到前台且过了一分钟再问。 */
export function useWorkbenchAgentEngines(): readonly WorkbenchAgentEngineStatus[] {
  useEffect(() => {
    refreshWhenStale()
    window.addEventListener('focus', refreshWhenStale)
    return () => window.removeEventListener('focus', refreshWhenStale)
  }, [])
  return useSyncExternalStore(
    subscribe,
    () => statuses,
    () => statuses
  )
}
