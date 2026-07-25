import type { WorkbenchProject } from './workbenchProjects'

function getComparableProjectName(project: WorkbenchProject): string {
  return project.name.trim().toLocaleLowerCase()
}

function getPathSegments(rootPath: string): string[] {
  return rootPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => !!segment)
}

function getComparablePathSuffix(segments: string[], length: number): string {
  return segments.slice(-length).join('/').toLocaleLowerCase()
}

/**
 * 非同名项目保留原名称；同名项目把标题收成能唯一识别项目的最短路径尾部。
 * 例如 agent-lab 的多个 `workspace` 会显示 `场景/workspace`；同一场景跨批次重复时
 * 自动再带上批次目录。
 */
export function createWorkbenchProjectTitleLabels(
  projects: readonly WorkbenchProject[]
): ReadonlyMap<string, string> {
  const projectsByName = new Map<string, WorkbenchProject[]>()
  for (const project of projects) {
    const comparableName = getComparableProjectName(project)
    const group = projectsByName.get(comparableName) ?? []
    group.push(project)
    projectsByName.set(comparableName, group)
  }

  const labels = new Map<string, string>()
  for (const project of projects) {
    const sameNameProjects = projectsByName.get(getComparableProjectName(project)) ?? []
    if (sameNameProjects.length < 2) {
      labels.set(project.id, project.name)
      continue
    }

    const segments = getPathSegments(project.rootPath)
    let suffixLength = Math.min(2, segments.length)
    while (suffixLength < segments.length) {
      const suffix = getComparablePathSuffix(segments, suffixLength)
      const hasConflict = sameNameProjects.some(
        (candidate) =>
          candidate.id !== project.id &&
          getComparablePathSuffix(getPathSegments(candidate.rootPath), suffixLength) === suffix
      )
      if (!hasConflict) break
      suffixLength += 1
    }

    const suffix = segments.slice(-suffixLength).join('/')
    labels.set(project.id, suffix)
  }

  return labels
}
