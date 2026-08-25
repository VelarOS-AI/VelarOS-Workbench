import type { WorkbenchLanguageServiceLocation } from '@shared/contracts'

export type WorkbenchSymbolLocationKind = 'definition' | 'reference'

export interface WorkbenchSymbolLocationItem {
  id: string
  kind: WorkbenchSymbolLocationKind
  location: WorkbenchLanguageServiceLocation
}

export interface WorkbenchSymbolLocationsRequest {
  symbol: string
  origin: WorkbenchLanguageServiceLocation
  items: readonly WorkbenchSymbolLocationItem[]
  truncated: boolean
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
  definitions,
  references,
}: {
  symbol: string
  origin: WorkbenchLanguageServiceLocation
  definitions: readonly WorkbenchLanguageServiceLocation[]
  references: readonly WorkbenchLanguageServiceLocation[]
}): WorkbenchSymbolLocationsRequest {
  const items: WorkbenchSymbolLocationItem[] = []
  const seen = new Set<string>()
  const append = (
    kind: WorkbenchSymbolLocationKind,
    locations: readonly WorkbenchLanguageServiceLocation[]
  ): void => {
    for (const location of locations) {
      const id = locationIdentity(location)
      if (seen.has(id)) continue
      seen.add(id)
      items.push({ id, kind, location })
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
    items: items.slice(0, MaximumSymbolLocations),
    truncated: items.length > MaximumSymbolLocations,
  }
}

export function openWorkbenchSymbolLocations(
  request: WorkbenchSymbolLocationsRequest
): WorkbenchSymbolLocationsState {
  return { ...request, activeLocation: request.origin, returnLocation: null }
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
  }
}

export function workbenchSymbolLocationDisplayPath(projectRoot: string, path: string): string {
  const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/$/u, '')
  const normalizedPath = path.replaceAll('\\', '/')
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath
}
