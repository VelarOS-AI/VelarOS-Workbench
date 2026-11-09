import { isArray, isTrue, Log } from '@velaros-ai/velaros/core'
import {
  isRecord,
  readNumberScalar as readNumber,
  readStringScalar as readString,
} from '@velaros-ai/velaros/core/utils/unknownJsonRecord'

import type { WorkbenchProject } from '@shared/projectHub'

import { createLocalStorageJsonStore, type StorageLike } from '../../support/localStorageJsonStore'

export type { WorkbenchProject } from '@shared/projectHub'

const STORAGE_KEY = 'velaros.workbench.projects.v1'
const log = Log.tag('workbench-projects')

export function normalizeWorkbenchProjectRootPath(rootPath: string): string {
  const path = rootPath.trim()
  if (/^[\\/]+$/u.test(path)) return path[0]!
  if (/^[A-Za-z]:[\\/]+$/u.test(path)) return path.slice(0, 3)
  return path.replace(/[\\/]+$/u, '')
}

function normalizeWorkbenchProjectList(projects: readonly WorkbenchProject[]): WorkbenchProject[] {
  const seenRoots = new Set<string>()
  const normalizedProjects: WorkbenchProject[] = []

  for (const project of projects) {
    const normalizedRootPath = normalizeWorkbenchProjectRootPath(project.rootPath)
    if (!normalizedRootPath || seenRoots.has(normalizedRootPath)) continue

    seenRoots.add(normalizedRootPath)
    normalizedProjects.push({
      ...project,
      rootPath: normalizedRootPath,
    })
  }

  return normalizedProjects
}

function normalizeWorkbenchProjects(value: unknown): WorkbenchProject[] {
  if (!isArray(value)) return []

  const projects = value
    .map((item): Nullable<WorkbenchProject> => {
      if (!isRecord(item)) return null

      const id = readString(item.id)
      const name = readString(item.name)
      const rootPath = normalizeWorkbenchProjectRootPath(readString(item.rootPath) ?? '')
      const createdAt = readNumber(item.createdAt)
      if (!id || !name || !rootPath || !createdAt) return null

      return {
        id,
        name,
        rootPath,
        createdAt,
        lastOpenedAt: readNumber(item.lastOpenedAt),
        pinned: isTrue(item.pinned),
      }
    })
    .filter((project): project is WorkbenchProject => !!project)

  return normalizeWorkbenchProjectList(projects)
}

const workbenchProjectsStore = createLocalStorageJsonStore<WorkbenchProject[]>({
  key: STORAGE_KEY,
  fallback: () => [],
  normalize: normalizeWorkbenchProjects,
  log,
  readErrorMessage: '读取 workbench 项目列表失败，使用空列表',
})

/** 新主进程 registry 首次初始化时导入的完整快照；renderer 不再写入此存储。 */
export function readWorkbenchProjects(storage?: StorageLike): WorkbenchProject[] {
  return workbenchProjectsStore.read(storage)
}
