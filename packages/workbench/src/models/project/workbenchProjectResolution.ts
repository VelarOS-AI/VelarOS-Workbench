import {
  createTransientWorkbenchProject,
  normalizeWorkbenchProjectRootPath,
  type WorkbenchProject,
} from './workbenchProjects'

export interface WorkbenchProjectResolution {
  project: WorkbenchProject
  projects: WorkbenchProject[]
  created: boolean
}

function markWorkbenchProjectOpened(
  project: WorkbenchProject,
  openedAt: number
): WorkbenchProject {
  return {
    ...project,
    lastOpenedAt: openedAt,
  }
}

export function resolveWorkbenchProjectForRootPath(
  rootPath: string,
  projects: WorkbenchProject[],
  openedAt = Date.now()
): WorkbenchProjectResolution {
  const normalizedRootPath = normalizeWorkbenchProjectRootPath(rootPath)
  const existing = projects.find(
    (project) => normalizeWorkbenchProjectRootPath(project.rootPath) === normalizedRootPath
  )

  if (existing) {
    const project = markWorkbenchProjectOpened(existing, openedAt)
    return {
      project,
      projects: projects.map((item) => (item.id === project.id ? project : item)),
      created: false,
    }
  }

  const project = markWorkbenchProjectOpened(
    createTransientWorkbenchProject(normalizedRootPath, openedAt),
    openedAt
  )

  return {
    project,
    projects,
    created: true,
  }
}
