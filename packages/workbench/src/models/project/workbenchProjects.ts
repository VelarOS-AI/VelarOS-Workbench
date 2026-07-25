import { isArray, isTrue,Log } from '@velaros/core'
import {
  isRecord,
  readNumberScalar as readNumber,
  readStringScalar as readString,
} from '@velaros/core/utils/unknownJsonRecord'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

export interface WorkbenchProject {
  id: string
  name: string
  rootPath: string
  createdAt: number
  lastOpenedAt: Nullable<number>
  pinned: boolean
}

const STORAGE_KEY = 'velaros.workbench.projects.v1'
const log = Log.tag('workbench-projects')

export function normalizeWorkbenchProjectRootPath(rootPath: string): string {
  return rootPath.trim().replace(/[\\/]+$/g, '')
}

function getProjectName(rootPath: string): string {
  const normalized = normalizeWorkbenchProjectRootPath(rootPath)
  const name = normalized.split(/[\\/]/).findLast((value) => !!value)
  return name || normalized || rootPath
}

function createProjectId(): string {
  const randomId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

  return `project-${randomId}`
}

function hashProjectRootPath(rootPath: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < rootPath.length; index += 1) {
    hash ^= rootPath.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function createWorkbenchProject(rootPath: string, now = Date.now()): WorkbenchProject {
  const normalizedRootPath = normalizeWorkbenchProjectRootPath(rootPath)

  return {
    id: createProjectId(),
    name: getProjectName(normalizedRootPath),
    rootPath: normalizedRootPath,
    createdAt: now,
    lastOpenedAt: null,
    pinned: false,
  }
}

/**
 * 程序化入口（hook 发起的 workbench 任务）：确保项目根已正式注册进项目工作区。
 * 已存在按根路径复用；不存在则创建并落盘（更新 lastOpenedAt），返回注册后的项目记录。
 */
export function ensureWorkbenchProjectRegistered(
  rootPath: string,
  storage?: StorageLike,
  now = Date.now()
): WorkbenchProject {
  const normalizedRootPath = normalizeWorkbenchProjectRootPath(rootPath)
  const projects = readWorkbenchProjects(storage)
  const existing = projects.find(
    (project) => normalizeWorkbenchProjectRootPath(project.rootPath) === normalizedRootPath
  )

  if (existing) {
    const opened = { ...existing, lastOpenedAt: now }
    saveWorkbenchProjects(
      projects.map((project) => (project.id === existing.id ? opened : project)),
      storage
    )
    return opened
  }

  const created = { ...createWorkbenchProject(normalizedRootPath, now), lastOpenedAt: now }
  saveWorkbenchProjects([created, ...projects], storage)
  return created
}

export function createTransientWorkbenchProject(
  rootPath: string,
  now = Date.now()
): WorkbenchProject {
  const normalizedRootPath = normalizeWorkbenchProjectRootPath(rootPath)

  return {
    id: `transient-project-${hashProjectRootPath(normalizedRootPath)}`,
    name: getProjectName(normalizedRootPath),
    rootPath: normalizedRootPath,
    createdAt: now,
    lastOpenedAt: now,
    pinned: false,
  }
}

export function normalizeWorkbenchProjectList(
  projects: readonly WorkbenchProject[]
): WorkbenchProject[] {
  const seenRoots = new Set<string>()
  const normalizedProjects: WorkbenchProject[] = []

  for (const project of projects) {
    const normalizedRootPath = normalizeWorkbenchProjectRootPath(project.rootPath)
    if (!normalizedRootPath || seenRoots.has(normalizedRootPath)) continue

    seenRoots.add(normalizedRootPath)
    normalizedProjects.push({
      ...project,
      name: project.name || getProjectName(normalizedRootPath),
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
  writeErrorMessage: '写入 workbench 项目列表失败',
})

export function readWorkbenchProjects(storage?: StorageLike): WorkbenchProject[] {
  return workbenchProjectsStore.read(storage)
}

export function saveWorkbenchProjects(projects: WorkbenchProject[], storage?: StorageLike): void {
  workbenchProjectsStore.write(normalizeWorkbenchProjectList(projects), storage)
}

export function getWorkbenchSessionId(projectId: string): string {
  return `workbench:${projectId}`
}
