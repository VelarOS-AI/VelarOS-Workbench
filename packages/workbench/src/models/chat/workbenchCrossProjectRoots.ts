import {
  normalizeWorkbenchProjectRootPath,
  type WorkbenchProject,
} from '../project/workbenchProjects'

function resolveWorkbenchCrossProjectRoots(
  activeProjectRoot: string,
  projects: readonly WorkbenchProject[]
): string[] {
  const roots = [
    normalizeWorkbenchProjectRootPath(activeProjectRoot),
    ...projects.map((project) => normalizeWorkbenchProjectRootPath(project.rootPath)),
  ]

  return roots.filter(
    (rootPath, index) => !!rootPath && roots.indexOf(rootPath) === index
  )
}

export { resolveWorkbenchCrossProjectRoots }
