import { mapDefined } from '@velaros-ai/core'

import type { VelarLogicGraphSnapshot } from '@shared/contributions/velar/logicGraph'

export interface WorkbenchVelarProjectSnapshot {
  projectRoot: string
  snapshot: VelarLogicGraphSnapshot
}

export type WorkbenchVelarProjectSnapshotIndex = ReadonlyMap<string, VelarLogicGraphSnapshot>

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

function pathContains(parent: string, child: string): boolean {
  return parent === '' || child === parent || child.startsWith(`${parent}/`)
}

function projectNodeId(projectRoot: string, nodeId: string): string {
  const encodedRoot = encodeURIComponent(projectRoot || '.')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
  return `velar-project(${encodedRoot}):${nodeId}`
}

function projectRootFromNodeId(nodeId: string): Nullable<string> {
  const match = /^velar-project\(([^)]*)\):/u.exec(nodeId)
  if (!match) return null
  try {
    const root = decodeURIComponent(match[1] ?? '')
    return root === '.' ? '' : normalizePath(root)
  } catch {
    return null
  }
}

function workspacePath(projectRoot: string, path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const normalized = normalizePath(path)
  if (!normalized) return projectRoot || undefined
  return projectRoot ? `${projectRoot}/${normalized}` : normalized
}

export function discoverWorkbenchVelarProjectRoots(paths: readonly string[]): string[] {
  const roots = new Set<string>()
  for (const path of paths) {
    const normalized = normalizePath(path)
    if (normalized === 'velar.json') roots.add('')
    else if (normalized.endsWith('/velar.json'))
      roots.add(normalized.slice(0, -'/velar.json'.length))
  }
  return [...roots].sort((left, right) => left.localeCompare(right))
}

export function getWorkbenchVelarDefaultScopePaths(
  projectRoots: readonly string[],
  fallbackRoot: Nullable<string>
): string[] {
  const roots = [...new Set(projectRoots.map(normalizePath))]
  if (roots.length > 1) return []

  const normalizedFallback = fallbackRoot === null ? '' : normalizePath(fallbackRoot)
  return normalizedFallback ? [normalizedFallback] : []
}

export function workbenchVelarProjectRootForPath(
  path: string,
  projectRoots: readonly string[]
): Nullable<string> {
  const normalized = normalizePath(path)
  return [...projectRoots]
    .map(normalizePath)
    .filter((root) => pathContains(root, normalized))
    .sort((left, right) => right.length - left.length)[0] ?? null
}

export function selectWorkbenchVelarProjectRoots(
  projectRoots: readonly string[],
  scopePaths: readonly string[],
  snapshot: Nullable<VelarLogicGraphSnapshot>
): string[] {
  const roots = [...new Set(projectRoots.map(normalizePath))]
  if (scopePaths.length === 0) return roots

  const selected = new Set<string>()
  for (const scope of scopePaths) {
    const node = snapshot?.nodes.find((candidate) => candidate.id === scope)
    const namespacedRoot = projectRootFromNodeId(scope)
    if (namespacedRoot !== null) selected.add(namespacedRoot)

    const path = normalizePath(node?.path ?? scope)
    if (!path || namespacedRoot !== null) continue
    const owner = workbenchVelarProjectRootForPath(path, roots)
    if (owner !== null) selected.add(owner)
    for (const root of roots) if (pathContains(path, root)) selected.add(root)
  }
  return roots.filter((root) => selected.has(root))
}

export function mergeWorkbenchVelarProjectSnapshots(
  projects: readonly WorkbenchVelarProjectSnapshot[]
): Nullable<VelarLogicGraphSnapshot> {
  if (projects.length === 0) return null

  const nodes = projects.flatMap(({ projectRoot, snapshot }) =>
    snapshot.nodes.map((node) => ({
      ...node,
      id: projectNodeId(projectRoot, node.id),
      path: mapDefined(node.path, (path) => workspacePath(projectRoot, path)),
    }))
  )
  const edges = projects.flatMap(({ projectRoot, snapshot }) =>
    snapshot.edges.map((edge) => ({
      ...edge,
      id: projectNodeId(projectRoot, edge.id),
      from: projectNodeId(projectRoot, edge.from),
      to: projectNodeId(projectRoot, edge.to),
      path: mapDefined(edge.path, (path) => workspacePath(projectRoot, path)),
    }))
  )
  const snapshots = projects.map(({ snapshot }) => snapshot)
  const first = snapshots[0]!
  return {
    protocolVersion: 1,
    mode: 'snapshot',
    rootUri: first.rootUri,
    revision: projects.map(({ projectRoot, snapshot }) => `${projectRoot}:${snapshot.revision}`).join('|'),
    nodes,
    edges,
    coverage: {
      modulesTotal: snapshots.reduce((total, snapshot) => total + snapshot.coverage.modulesTotal, 0),
      modulesIncluded: snapshots.reduce(
        (total, snapshot) => total + snapshot.coverage.modulesIncluded,
        0
      ),
      complete: snapshots.every((snapshot) => snapshot.coverage.complete),
      callRelations: snapshots.every(
        (snapshot) => snapshot.coverage.callRelations === first.coverage.callRelations
      )
        ? first.coverage.callRelations
        : 'mixed',
      memberCallRelations: snapshots.every(
        (snapshot) => snapshot.coverage.memberCallRelations
      ),
    },
    limitReached: snapshots.some((snapshot) => snapshot.limitReached),
    durationMs: snapshots.reduce((total, snapshot) => total + snapshot.durationMs, 0),
    activity: {
      strategy: snapshots.every((snapshot) => snapshot.activity.strategy === 'affected-modules')
        ? 'affected-modules'
        : 'full',
      modulesVisited: snapshots.reduce(
        (total, snapshot) => total + snapshot.activity.modulesVisited,
        0
      ),
    },
  }
}

export function updateWorkbenchVelarProjectSnapshotIndex(
  current: WorkbenchVelarProjectSnapshotIndex,
  projects: readonly WorkbenchVelarProjectSnapshot[]
): WorkbenchVelarProjectSnapshotIndex {
  const next = new Map(current)
  for (const project of projects) next.set(normalizePath(project.projectRoot), project.snapshot)
  return next
}

export function mergeWorkbenchVelarProjectSnapshotIndex(
  index: WorkbenchVelarProjectSnapshotIndex,
  projectRoots: readonly string[] = [...index.keys()]
): Nullable<VelarLogicGraphSnapshot> {
  return mergeWorkbenchVelarProjectSnapshots(
    projectRoots.flatMap((projectRoot) => {
      const normalizedRoot = normalizePath(projectRoot)
      const snapshot = index.get(normalizedRoot)
      return snapshot ? [{ projectRoot: normalizedRoot, snapshot }] : []
    })
  )
}
