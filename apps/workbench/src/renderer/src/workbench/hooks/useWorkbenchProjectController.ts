import { useMemo, useRef, useState } from 'react'
import type { SystemOverview } from '@workbench/contracts'
import { workbenchHost } from '@workbench/host'
import {
  createWorkbenchProject,
  getWorkbenchSessionId,
  normalizeWorkbenchProjectList,
  normalizeWorkbenchProjectRootPath,
  readWorkbenchProjects,
  saveWorkbenchProjects,
  type WorkbenchProject,
} from '@workbench/models/project/workbenchProjects'
import { sortProjects } from '@workbench/models/shared/workbenchUtils'

import { Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMemoizedFn } from '../support/genericHooks'
import { persistSessionWorkspaceOverview } from '../support/sessionWorkspacePersistence'

const log = Log.tag('workbench-project-controller')

type OpenProjectHandler = (
  project: WorkbenchProject,
  sourceProjects?: WorkbenchProject[]
) => Promise<void>

interface WorkbenchProjectWorkspaceBindingApi {
  addWorkspaceRoot: (
    sessionId: string,
    path: string,
    options?: { activate?: boolean }
  ) => Promise<Result<SystemOverview>>
  setActiveWorkspaceRoot: (sessionId: string, path: string) => Promise<Result<SystemOverview>>
}

interface UseWorkbenchProjectControllerOptions {
  bootstrapActiveProjectId?: LooseOptional<string>
  bootstrapProjects?: readonly WorkbenchProject[]
  persistProjectList?: boolean
}

function resolveBootstrapActiveProjectId(
  bootstrapActiveProjectId: LooseOptional<string>,
  projects: readonly WorkbenchProject[]
): Nullable<string> {
  if (!bootstrapActiveProjectId) return null

  return projects.some((project) => project.id === bootstrapActiveProjectId)
    ? bootstrapActiveProjectId
    : null
}

function readInitialWorkbenchProjects(
  bootstrapProjects: readonly WorkbenchProject[] = []
): WorkbenchProject[] {
  return normalizeWorkbenchProjectList([...readWorkbenchProjects(), ...bootstrapProjects])
}

export async function bindWorkbenchProjectWorkspace(
  project: WorkbenchProject,
  relatedProjects: readonly WorkbenchProject[] = [project],
  api: WorkbenchProjectWorkspaceBindingApi = workbenchHost.kernel.workspace
): Promise<Nullable<SystemOverview>> {
  const sessionId = getWorkbenchSessionId(project.id)
  const registeredProjects = normalizeWorkbenchProjectList([project, ...relatedProjects])

  // 每个 Workbench 会话都登记项目列表中的其他根，但只把当前项目设为 active。
  // 这样 dispatch_agent 可以为其他 project 建独立 lane，又不会把编辑器绑定切走。
  //
  // 独立宿主宽容化：ProjectHub 拒绝失效路径时只记录诊断，不阻断当前编辑器状态。
  for (const registeredProject of registeredProjects) {
    const added = await api.addWorkspaceRoot(sessionId, registeredProject.rootPath, {
      activate: false,
    })
    if (!added.ok) {
      log.debug('Workspace 根登记不可用（kernel 未接入），跳过绑定', { sessionId })
      return null
    }
  }
  const activated = await api.setActiveWorkspaceRoot(sessionId, project.rootPath)
  if (!activated.ok) {
    log.debug('Workspace 活跃根切换不可用（kernel 未接入），跳过绑定', { sessionId })
    return null
  }
  persistSessionWorkspaceOverview(sessionId, activated.data)
  return activated.data
}

export function useWorkbenchProjectController(
  options: UseWorkbenchProjectControllerOptions = {}
) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const initialProjectsRef = useRef<Nullable<WorkbenchProject[]>>(null)
  if (!initialProjectsRef.current) {
    initialProjectsRef.current = readInitialWorkbenchProjects(options.bootstrapProjects)
  }
  const shouldPersistProjectList = options.persistProjectList ?? true
  const [projects, setProjects] = useState<WorkbenchProject[]>(() => initialProjectsRef.current ?? [])
  const [activeProjectId, setActiveProjectId] = useState<Nullable<string>>(() =>
    resolveBootstrapActiveProjectId(
      options.bootstrapActiveProjectId,
      initialProjectsRef.current ?? []
    )
  )
  const [isPicking, setIsPicking] = useState(false)
  const [workspaceBindingVersion, setWorkspaceBindingVersion] = useState(0)
  const projectsRef = useLatest(projects)

  const sortedProjects = useMemo(() => sortProjects(projects), [projects])
  const activeProject = toNullable(projects.find((project) => project.id === activeProjectId))

  function persistProjects(nextProjects: WorkbenchProject[]): void {
    const normalizedProjects = normalizeWorkbenchProjectList(nextProjects)
    setProjects(normalizedProjects)
    if (shouldPersistProjectList) {
      saveWorkbenchProjects(normalizedProjects)
    }
  }

  function markProjectOpened(
    projectId: string,
    sourceProjects: WorkbenchProject[] = projects
  ): void {
    const now = Date.now()
    persistProjects(
      sourceProjects.map((item) =>
        item.id === projectId
          ? {
              ...item,
              lastOpenedAt: now,
            }
          : item
      )
    )
  }

  async function bindProjectWorkspace(
    project: WorkbenchProject,
    relatedProjects: readonly WorkbenchProject[] = projectsRef.current
  ): Promise<void> {
    await bindWorkbenchProjectWorkspace(project, relatedProjects)
    setWorkspaceBindingVersion((version) => version + 1)
  }

  const addProject = useMemoizedFn(async (openProjectHandler: OpenProjectHandler): Promise<void> => {
    try {
      setIsPicking(true)
      const selectedPath = Result.unwrap(await workbenchHost.kernel.workspace.pickDirectory())
      if (!selectedPath) return

      const currentProjects = projectsRef.current
      const selectedRootPath = normalizeWorkbenchProjectRootPath(selectedPath)

      const existing = currentProjects.find(
        (project) => normalizeWorkbenchProjectRootPath(project.rootPath) === selectedRootPath
      )
      if (existing) {
        await openProjectHandler(existing)
        return
      }

      const created = createWorkbenchProject(selectedRootPath)
      const nextProjects = [created, ...currentProjects]
      persistProjects(nextProjects)
      await openProjectHandler(created, nextProjects)
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.addProjectFailed'),
        description: appError.message,
      })
    } finally {
      setIsPicking(false)
    }
  })

  function removeProject(projectId: string): void {
    persistProjects(projects.filter((project) => project.id !== projectId))
  }

  function activateProject(projectId: string): void {
    setActiveProjectId(projectId)
  }

  function clearActiveProject(): void {
    setActiveProjectId(null)
  }

  return {
    projects,
    sortedProjects,
    activeProject,
    activeProjectId,
    isPicking,
    workspaceBindingVersion,
    addProject,
    removeProject,
    markProjectOpened,
    bindProjectWorkspace,
    activateProject,
    clearActiveProject,
  }
}
