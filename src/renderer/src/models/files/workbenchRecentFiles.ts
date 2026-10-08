import { isArray, Log } from '@velaros-ai/core'
import {
  isRecord,
  readStringScalar as readString,
} from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../support/localStorageJsonStore'

/**
 * 每个项目最近打开过的文件（相对项目根），最近的在前：快速打开没有输入时列出它们，有输入时给它们加分。
 * 按项目存在本机，重开项目还在。
 */
const STORAGE_KEY = 'velaros.workbench.recent-files.v1'
export const MAX_WORKBENCH_RECENT_FILES = 50
const log = Log.tag('workbench-recent-files')

type WorkbenchRecentFileMap = Record<string, string[]>

/** 记下刚打开（切到）的文件：挪到最前面，超出上限的最旧的丢掉。 */
export function recordWorkbenchRecentFile(
  recentPaths: readonly string[],
  path: string,
  limit = MAX_WORKBENCH_RECENT_FILES
): string[] {
  const normalized = path.trim()
  if (!normalized) return [...recentPaths]

  return [normalized, ...recentPaths.filter((item) => item !== normalized)].slice(0, Math.max(1, limit))
}

/** 存下来的一个项目的列表：只留非空、不重复的路径，最多上限条。 */
export function normalizeWorkbenchRecentFiles(value: unknown): string[] {
  if (!isArray(value)) return []

  const paths: string[] = []
  for (const item of value) {
    const path = readString(item)?.trim()
    if (!path || paths.includes(path)) continue

    paths.push(path)
    if (paths.length >= MAX_WORKBENCH_RECENT_FILES) break
  }
  return paths
}

function normalizeRecentFileMap(value: unknown): WorkbenchRecentFileMap {
  if (!isRecord(value)) return {}

  const map: WorkbenchRecentFileMap = {}
  for (const [projectId, paths] of Object.entries(value)) {
    const id = projectId.trim()
    const normalized = normalizeWorkbenchRecentFiles(paths)
    if (id && normalized.length > 0) map[id] = normalized
  }
  return map
}

const workbenchRecentFileStore = createLocalStorageJsonStore<WorkbenchRecentFileMap>({
  key: STORAGE_KEY,
  fallback: () => ({}),
  normalize: normalizeRecentFileMap,
  log,
  readErrorMessage: '读取最近打开的文件失败，按没有记录处理',
  writeErrorMessage: '写入最近打开的文件失败',
})

export function readWorkbenchRecentFiles(projectId: string, storage?: StorageLike): string[] {
  const id = projectId.trim()
  if (!id) return []

  return workbenchRecentFileStore.read(storage)[id] ?? []
}

export function saveWorkbenchRecentFiles(
  projectId: string,
  paths: readonly string[],
  storage?: StorageLike
): void {
  const id = projectId.trim()
  if (!id) return

  workbenchRecentFileStore.update(
    (map) => ({ ...map, [id]: normalizeWorkbenchRecentFiles(paths) }),
    storage
  )
}
