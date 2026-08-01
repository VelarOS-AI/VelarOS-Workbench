import { ROOT_PATH } from '../shared/workbenchUtils'

export type WorkbenchPathBreadcrumbKind = 'directory' | 'file' | 'root'

export interface WorkbenchPathBreadcrumbItem {
  id: string
  kind: WorkbenchPathBreadcrumbKind
  label: string
  path: string
}

function splitWorkbenchPath(path: Nullable<string>): string[] {
  if (!path || path === ROOT_PATH) return []

  return path.split('/').filter((value) => !!value)
}

export function buildWorkbenchPathBreadcrumbs(
  path: Nullable<string>,
  rootLabel: string
): WorkbenchPathBreadcrumbItem[] {
  const segments = splitWorkbenchPath(path)
  const breadcrumbs: WorkbenchPathBreadcrumbItem[] = [
    {
      id: ROOT_PATH,
      kind: 'root',
      label: rootLabel,
      path: ROOT_PATH,
    },
  ]

  segments.forEach((segment, index) => {
    const segmentPath = segments.slice(0, index + 1).join('/')
    breadcrumbs.push({
      id: segmentPath,
      kind: index === segments.length - 1 ? 'file' : 'directory',
      label: segment,
      path: segmentPath,
    })
  })

  return breadcrumbs
}

export function getWorkbenchPathAncestorDirectories(path: Nullable<string>): string[] {
  const segments = splitWorkbenchPath(path)
  const ancestors = [ROOT_PATH]

  for (let index = 0; index < Math.max(0, segments.length - 1); index += 1) {
    ancestors.push(segments.slice(0, index + 1).join('/'))
  }

  return ancestors
}

export function getWorkbenchPathParentDirectory(path: string): string {
  const segments = splitWorkbenchPath(path)
  if (segments.length <= 1) return ROOT_PATH

  return segments.slice(0, -1).join('/')
}
