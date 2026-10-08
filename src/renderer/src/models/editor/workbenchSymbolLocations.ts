import { type WorkbenchLanguageServiceLocation } from '@shared/contracts/workbench'

export type WorkbenchSymbolLocationKind = 'definition' | 'reference'

export interface WorkbenchSymbolLocationItem {
  id: string
  kind: WorkbenchSymbolLocationKind
  location: WorkbenchLanguageServiceLocation
}

export interface WorkbenchSymbolLocationsRequest {
  symbol: string
  origin: WorkbenchLanguageServiceLocation
  destination?: WorkbenchLanguageServiceLocation
  items: readonly WorkbenchSymbolLocationItem[]
  truncated: boolean
  /** 面板一出来就把键盘焦点放进列表（「查找引用」要在列表里上下挑）；跳过一次之后焦点留在编辑器里。 */
  focusList?: boolean
}

export interface WorkbenchSymbolLocationsState extends WorkbenchSymbolLocationsRequest {
  activeLocation: WorkbenchLanguageServiceLocation
  returnLocation: Nullable<WorkbenchLanguageServiceLocation>
}

const MaximumSymbolLocations = 500

function locationIdentity(location: WorkbenchLanguageServiceLocation): string {
  return `${location.path}:${location.line}:${location.column}`
}

export function sameWorkbenchSymbolLocation(
  left: WorkbenchLanguageServiceLocation,
  right: WorkbenchLanguageServiceLocation
): boolean {
  return locationIdentity(left) === locationIdentity(right)
}

export function buildWorkbenchSymbolLocationsRequest({
  symbol,
  origin,
  destination,
  definitions,
  references,
  focusList,
}: {
  symbol: string
  origin: WorkbenchLanguageServiceLocation
  destination?: WorkbenchLanguageServiceLocation
  definitions: readonly WorkbenchLanguageServiceLocation[]
  references: readonly WorkbenchLanguageServiceLocation[]
  focusList?: boolean
}): WorkbenchSymbolLocationsRequest {
  const items: WorkbenchSymbolLocationItem[] = []
  const seen = new Map<string, WorkbenchSymbolLocationItem>()
  const append = (
    kind: WorkbenchSymbolLocationKind,
    locations: readonly WorkbenchLanguageServiceLocation[]
  ): void => {
    for (const location of locations) {
      const id = locationIdentity(location)
      const existing = seen.get(id)
      if (existing) {
        // 同一处既是定义又在引用里：只列一次（算定义），那一行的文字引用那份带着，接过来。
        if (existing.location.preview === undefined && location.preview !== undefined)
          existing.location = { ...existing.location, preview: location.preview }
        continue
      }
      const item = { id, kind, location }
      seen.set(id, item)
      items.push(item)
    }
  }

  append('definition', definitions)
  append('reference', references)
  items.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'definition' ? -1 : 1
    return (
      left.location.path.localeCompare(right.location.path) ||
      left.location.line - right.location.line ||
      left.location.column - right.location.column
    )
  })

  return {
    symbol,
    origin,
    destination,
    items: items.slice(0, MaximumSymbolLocations),
    truncated: items.length > MaximumSymbolLocations,
    focusList,
  }
}

/** 面板里一个文件的那一段。 */
export interface WorkbenchSymbolLocationGroup {
  path: string
  items: WorkbenchSymbolLocationItem[]
}

/**
 * 面板按文件分组列：发起时所在的文件排最前（多半先看眼前这个文件里的），别的按路径；一组里按行列，定义与
 * 引用混着排（定义那一行另有标记）。
 */
export function groupWorkbenchSymbolLocations(
  items: readonly WorkbenchSymbolLocationItem[],
  firstPath: string
): WorkbenchSymbolLocationGroup[] {
  const groups = new Map<string, WorkbenchSymbolLocationItem[]>()
  for (const item of items) {
    const group = groups.get(item.location.path)
    if (group) group.push(item)
    else groups.set(item.location.path, [item])
  }

  return [...groups]
    .map(([path, groupItems]) => ({
      path,
      items: groupItems.sort(
        (left, right) =>
          left.location.line - right.location.line || left.location.column - right.location.column
      ),
    }))
    .sort((left, right) => {
      if (left.path === firstPath || right.path === firstPath)
        return left.path === right.path ? 0 : left.path === firstPath ? -1 : 1
      return left.path.localeCompare(right.path)
    })
}

export function openWorkbenchSymbolLocations(
  request: WorkbenchSymbolLocationsRequest
): WorkbenchSymbolLocationsState {
  const opened = { ...request, activeLocation: request.origin, returnLocation: null }
  return request.destination
    ? navigateWorkbenchSymbolLocations(opened, request.destination)
    : opened
}

export function navigateWorkbenchSymbolLocations(
  state: WorkbenchSymbolLocationsState,
  destination: WorkbenchLanguageServiceLocation
): WorkbenchSymbolLocationsState {
  if (sameWorkbenchSymbolLocation(state.activeLocation, destination)) return state
  return {
    ...state,
    returnLocation: state.activeLocation,
    activeLocation: destination,
    focusList: false,
  }
}

export function workbenchSymbolLocationDisplayPath(projectRoot: string, path: string): string {
  const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/$/u, '')
  const normalizedPath = path.replaceAll('\\', '/')
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath
}
