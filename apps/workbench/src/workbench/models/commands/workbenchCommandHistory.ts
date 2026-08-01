import { isArray, isEmpty,isPresent, isTrue, Log, numberOrNull, trimmedStringOrEmpty } from '@velaros-ai/core'
import { isRecord, readNumberScalar as readNumber } from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

export interface WorkbenchCommandHistoryItem {
  command: string
  lastRunAt: number
  lastSuccess: boolean
  durationMs: number
  exitCode: Nullable<number>
}

const STORAGE_KEY = 'velaros.workbench.command-history.v1'
const MAX_HISTORY_ITEMS = 8
const log = Log.tag('workbench-command-history')

function normalizeCommandHistoryMap(value: unknown): Record<string, WorkbenchCommandHistoryItem[]> {
  if (!isRecord(value)) return {}

  const result: Record<string, WorkbenchCommandHistoryItem[]> = {}
  for (const [projectId, historyValue] of Object.entries(value)) {
    if (!isArray(historyValue)) {
      continue
    }

    const items = historyValue
      .map((item): Nullable<WorkbenchCommandHistoryItem> => {
        if (!isRecord(item)) return null

        const command = trimmedStringOrEmpty(item.command)
        const lastRunAt = readNumber(item.lastRunAt)
        const durationMs = readNumber(item.durationMs)
        const exitCode = numberOrNull(item.exitCode)
        if (!command || !lastRunAt || !isPresent(durationMs)) return null

        return {
          command,
          lastRunAt,
          lastSuccess: isTrue(item.lastSuccess),
          durationMs,
          exitCode,
        }
      })
      .filter((item): item is WorkbenchCommandHistoryItem => !!item)
      .slice(0, MAX_HISTORY_ITEMS)

    if (!isEmpty(items)) {
      result[projectId] = items
    }
  }

  return result
}

const workbenchCommandHistoryStore = createLocalStorageJsonStore<
  Record<string, WorkbenchCommandHistoryItem[]>
>({
  key: STORAGE_KEY,
  fallback: () => ({}),
  normalize: normalizeCommandHistoryMap,
  log,
  readErrorMessage: '读取 workbench 命令历史失败，使用空历史',
  writeErrorMessage: '写入 workbench 命令历史失败',
})

function readCommandHistoryMap(
  storage?: StorageLike
): Record<string, WorkbenchCommandHistoryItem[]> {
  return workbenchCommandHistoryStore.read(storage)
}

function writeCommandHistoryMap(
  map: Record<string, WorkbenchCommandHistoryItem[]>,
  storage?: StorageLike
): void {
  workbenchCommandHistoryStore.write(map, storage)
}

export function readWorkbenchCommandHistory(
  projectId: string,
  storage?: StorageLike
): WorkbenchCommandHistoryItem[] {
  return readCommandHistoryMap(storage)[projectId] ?? []
}

export function saveWorkbenchCommandHistory(
  projectId: string,
  items: WorkbenchCommandHistoryItem[],
  storage?: StorageLike
): void {
  const map = readCommandHistoryMap(storage)
  map[projectId] = items.slice(0, MAX_HISTORY_ITEMS)
  writeCommandHistoryMap(map, storage)
}

export function upsertWorkbenchCommandHistory(
  projectId: string,
  item: WorkbenchCommandHistoryItem,
  storage?: StorageLike
): WorkbenchCommandHistoryItem[] {
  const current = readWorkbenchCommandHistory(projectId, storage)
  const next = [item, ...current.filter((candidate) => candidate.command !== item.command)].slice(
    0,
    MAX_HISTORY_ITEMS
  )
  saveWorkbenchCommandHistory(projectId, next, storage)
  return next
}
