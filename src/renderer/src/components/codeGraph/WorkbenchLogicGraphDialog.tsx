import {
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsDownUpIcon,
  ArrowsLeftRightIcon,
  ArrowSquareOutIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useWorkbenchHostRuntime } from '@renderer/host/WorkbenchHostProvider'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type { WorkbenchThemeId } from '@renderer/models/workbenchPreferences'
import {
  mergeWorkbenchVelarProjectSnapshotIndex,
  selectWorkbenchVelarProjectRoots,
  workbenchVelarProjectRootForPath,
  type WorkbenchVelarProjectSnapshot,
  type WorkbenchVelarProjectSnapshotIndex,
} from '@renderer/models/workbenchVelarProjectGraph'

import { Result } from '@velaros-ai/core/result'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'

import { type WorkbenchCodeGraphEdge, type WorkbenchCodeGraphNode } from '@shared/contracts/workbench'
import {
  applyVelarLogicGraphResponse,
  parseVelarLogicGraphResponse,
  velarLogicGraphForWorkbench,
  type VelarLogicGraphSnapshot,
  VelarOwnershipGraphRequestId,
} from '@shared/contributions/velar/logicGraph'

import styles from '../../styles/workbenchPageStyles'
import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'
import { ReadOnlyWorkbenchCode } from '../editor/ReadOnlyWorkbenchCode'

import { isRelevantVelarPath } from './WorkbenchLogicGraphScopeTree'

type WorkbenchVelarStructureView = 'overview' | 'selection'
type LogicGraphDirection = 'vertical' | 'horizontal'
type LogicGraphRelationFilter = 'all' | 'imports' | 'calls' | 'data' | 'owns' | 'capability'

const ViewLimits: Record<WorkbenchVelarStructureView, { nodes: number; edges: number }> = {
  overview: { nodes: 36, edges: 54 },
  selection: { nodes: 72, edges: 120 },
}

const OverviewRelationKinds = new Set(['imports'])
const SelectionRelationKinds = new Set([
  'owns',
  'reads',
  'writes',
  'derives',
  'calls',
  'crossesCapability',
])
const SelectionNodeKinds = new Set([
  'action',
  'capability',
  'class',
  'component',
  'computed',
  'enum',
  'function',
  'method',
  'state',
  'type',
  'variable',
])

interface WorkbenchLogicGraphEditorProps {
  active: boolean
  projectRoot: string
  projectRoots: readonly string[]
  scopePaths: readonly string[]
  selectedFilePath: Nullable<string>
  selectedContent: string
  openTabs: readonly WorkbenchOpenEditorTab[]
  projectFiles: ReadonlyArray<{ path: string }>
  projectSnapshots: WorkbenchVelarProjectSnapshotIndex
  refreshVersion: number
  workbenchTheme: WorkbenchThemeId
  onProjectSnapshotsChange: (projects: readonly WorkbenchVelarProjectSnapshot[]) => void
  onOpenSource: (source: { path: string; content: string; line?: number; column?: number }) => void
}

interface PositionedNode extends WorkbenchCodeGraphNode {
  x: number
  y: number
}

interface NodeDragState {
  nodeId: string
  pointerId: number
  clientX: number
  clientY: number
  x: number
  y: number
  moved: boolean
}

interface GraphPanState {
  pointerId: number
  clientX: number
  clientY: number
  scrollLeft: number
  scrollTop: number
}

interface NodeCodeSnippet {
  code: string
  startLine: number
  truncated: boolean
}

function nodeCodeSnippet(
  content: string,
  range: VelarLogicGraphSnapshot['nodes'][number]['range'],
  line?: number
): NodeCodeSnippet {
  const lines = content.split(/\r?\n/)
  const start = Math.max(0, Math.min(lines.length - 1, range?.start.line ?? (line ?? 1) - 1))
  const requestedEnd = range?.end.line ?? start + 7
  const maximumLines = 18
  const end = Math.max(start, Math.min(lines.length - 1, requestedEnd, start + maximumLines - 1))
  return {
    code: lines.slice(start, end + 1).join('\n'),
    startLine: start + 1,
    truncated: requestedEnd > end,
  }
}

interface PositionedContextLane {
  name: string
  y: number
  height: number
}

interface LogicGraphLayout {
  nodes: PositionedNode[]
  lanes: PositionedContextLane[]
  width: number
  height: number
}

function deduplicateEdges(edges: readonly WorkbenchCodeGraphEdge[]): WorkbenchCodeGraphEdge[] {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.kind}\u0000${edge.from}\u0000${edge.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function projectOverviewSelection(
  snapshot: VelarLogicGraphSnapshot,
  maximumNodes: number,
  cycleNodeIds: ReadonlySet<string>
): Set<string> {
  const degree = new Map<string, number>()
  for (const edge of snapshot.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const score = (node: VelarLogicGraphSnapshot['nodes'][number]): number =>
    (node.exported ? 1_200 : 0) +
    (node.kind === 'module' ? 900 : 400) +
    Math.min(500, (degree.get(node.id) ?? 0) * 18)
  const candidates = snapshot.nodes
    .filter((node) => !node.path?.includes('.test.vel'))
    .sort(
      (left, right) =>
        score(right) - score(left) ||
        (right.path ?? '').localeCompare(left.path ?? '') ||
        left.name.localeCompare(right.name)
    )
  const selected = new Set<string>()
  for (const node of candidates) {
    if (!cycleNodeIds.has(node.id)) continue
    selected.add(node.id)
    if (selected.size >= maximumNodes) return selected
  }
  for (const node of candidates) {
    selected.add(node.id)
    if (selected.size >= maximumNodes) break
  }
  return selected
}

function edgeIdentity(edge: WorkbenchCodeGraphEdge): string {
  return `${edge.kind}\u0000${edge.from}\u0000${edge.to}`
}

interface LogicGraphTopology {
  ranks: ReadonlyMap<string, number>
  cycleNodeIds: ReadonlySet<string>
  cycleEdgeKeys: ReadonlySet<string>
  cycleCount: number
}

function analyzeLogicGraphTopology(
  nodes: ReadonlyArray<{ id: string }>,
  edges: readonly WorkbenchCodeGraphEdge[],
  rootNodeIds: ReadonlySet<string> = new Set()
): LogicGraphTopology {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]))
  const reverse = new Map(nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue
    adjacency.get(edge.from)?.push(edge.to)
    reverse.get(edge.to)?.push(edge.from)
  }

  const visited = new Set<string>()
  const finishOrder: string[] = []
  for (const node of nodes) {
    if (visited.has(node.id)) continue
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: node.id, expanded: false }]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      if (current.expanded) {
        finishOrder.push(current.id)
        continue
      }
      if (visited.has(current.id)) continue
      visited.add(current.id)
      stack.push({ id: current.id, expanded: true })
      const targets = adjacency.get(current.id) ?? []
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const target = targets[index]
        if (target && !visited.has(target)) stack.push({ id: target, expanded: false })
      }
    }
  }

  const componentByNode = new Map<string, number>()
  const components: string[][] = []
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const seed = finishOrder[index]
    if (!seed || componentByNode.has(seed)) continue
    const component = components.length
    const members: string[] = []
    const stack = [seed]
    componentByNode.set(seed, component)
    while (stack.length > 0) {
      const id = stack.pop()
      if (!id) continue
      members.push(id)
      for (const source of reverse.get(id) ?? []) {
        if (componentByNode.has(source)) continue
        componentByNode.set(source, component)
        stack.push(source)
      }
    }
    components.push(members)
  }

  const selfLoopComponents = new Set<number>()
  const componentEdges = new Map<number, Set<number>>()
  const componentIncoming = new Map<number, number>()
  const componentLabels = new Map<number, string>()
  components.forEach((members, component) => {
    componentEdges.set(component, new Set())
    componentIncoming.set(component, 0)
    componentLabels.set(component, [...members].sort()[0] ?? '')
  })
  for (const edge of edges) {
    const from = componentByNode.get(edge.from)
    const to = componentByNode.get(edge.to)
    if (from === undefined || to === undefined) continue
    if (from === to) {
      if (edge.from === edge.to) selfLoopComponents.add(from)
      continue
    }
    const targets = componentEdges.get(from)
    if (!targets || targets.has(to)) continue
    targets.add(to)
    componentIncoming.set(to, (componentIncoming.get(to) ?? 0) + 1)
  }

  const cyclicComponents = new Set<number>()
  components.forEach((members, component) => {
    if (members.length > 1 || selfLoopComponents.has(component)) cyclicComponents.add(component)
  })
  const cycleNodeIds = new Set<string>()
  cyclicComponents.forEach((component) => {
    for (const id of components[component] ?? []) cycleNodeIds.add(id)
  })
  const cycleEdgeKeys = new Set<string>()
  for (const edge of edges) {
    const component = componentByNode.get(edge.from)
    if (
      component !== undefined &&
      component === componentByNode.get(edge.to) &&
      cyclicComponents.has(component)
    ) {
      cycleEdgeKeys.add(edgeIdentity(edge))
    }
  }

  const queue = [...componentIncoming.entries()]
    .filter(([, incoming]) => incoming === 0)
    .map(([component]) => component)
    .sort((left, right) =>
      (componentLabels.get(left) ?? '').localeCompare(componentLabels.get(right) ?? '')
    )
  const componentOrder: number[] = []
  const topologicalRanks = new Map<number, number>()
  queue.forEach((component) => topologicalRanks.set(component, 0))
  while (queue.length > 0) {
    const component = queue.shift()
    if (component === undefined) continue
    componentOrder.push(component)
    const rank = topologicalRanks.get(component) ?? 0
    for (const target of componentEdges.get(component) ?? []) {
      topologicalRanks.set(target, Math.max(topologicalRanks.get(target) ?? 0, rank + 1))
      const incoming = (componentIncoming.get(target) ?? 0) - 1
      componentIncoming.set(target, incoming)
      if (incoming === 0) {
        queue.push(target)
        queue.sort((left, right) =>
          (componentLabels.get(left) ?? '').localeCompare(componentLabels.get(right) ?? '')
        )
      }
    }
  }

  const rootComponents = new Set(
    [...rootNodeIds].flatMap((id) => {
      const component = componentByNode.get(id)
      return component === undefined ? [] : [component]
    })
  )
  if (rootComponents.size > 0) {
    const reachable = new Set(rootComponents)
    const reachQueue = [...rootComponents]
    while (reachQueue.length > 0) {
      const component = reachQueue.shift()
      if (component === undefined) continue
      for (const target of componentEdges.get(component) ?? []) {
        if (reachable.has(target)) continue
        reachable.add(target)
        reachQueue.push(target)
      }
    }
    const rootedRanks = new Map<number, number>()
    rootComponents.forEach((component) => rootedRanks.set(component, 0))
    for (const component of componentOrder) {
      if (!reachable.has(component)) continue
      const rank = rootedRanks.get(component)
      if (rank === undefined) continue
      for (const target of componentEdges.get(component) ?? []) {
        if (!reachable.has(target)) continue
        rootedRanks.set(target, Math.max(rootedRanks.get(target) ?? 0, rank + 1))
      }
    }
    for (const [component, rank] of rootedRanks) topologicalRanks.set(component, rank)
  }

  const ranks = new Map<string, number>()
  for (const node of nodes) {
    ranks.set(node.id, topologicalRanks.get(componentByNode.get(node.id) ?? -1) ?? 0)
  }
  return {
    ranks,
    cycleNodeIds,
    cycleEdgeKeys,
    cycleCount: cyclicComponents.size,
  }
}

function selectOverviewEdges(
  edges: readonly WorkbenchCodeGraphEdge[],
  cycleEdgeKeys: ReadonlySet<string>
): WorkbenchCodeGraphEdge[] {
  const relationPriority: Record<string, number> = {
    calls: 0,
    writes: 1,
    reads: 2,
    derives: 3,
    imports: 4,
    crossesCapability: 5,
    owns: 6,
    projectsReadonly: 7,
  }
  const outgoing = new Map<string, number>()
  const incoming = new Map<string, number>()
  const maximumOutgoing = 3
  const selected: WorkbenchCodeGraphEdge[] = []
  for (const edge of [...edges].sort((left, right) => {
    const cycleOrder =
      Number(cycleEdgeKeys.has(edgeIdentity(right))) - Number(cycleEdgeKeys.has(edgeIdentity(left)))
    return cycleOrder || (relationPriority[left.kind] ?? 99) - (relationPriority[right.kind] ?? 99)
  })) {
    if (cycleEdgeKeys.has(edgeIdentity(edge))) {
      selected.push(edge)
      continue
    }
    if ((outgoing.get(edge.from) ?? 0) >= maximumOutgoing) continue
    if ((incoming.get(edge.to) ?? 0) >= 2) continue
    selected.push(edge)
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }
  return selected
}

function positionDependencyTree(
  nodes: readonly WorkbenchCodeGraphNode[],
  edges: readonly WorkbenchCodeGraphEdge[],
  topology: LogicGraphTopology,
  direction: LogicGraphDirection
): LogicGraphLayout {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    const sourceRank = topology.ranks.get(edge.from)
    const targetRank = topology.ranks.get(edge.to)
    if (sourceRank === undefined || targetRank === undefined || sourceRank >= targetRank) continue
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from])
  }

  const nodeOrder = (leftId: string, rightId: string): number => {
    const left = nodeById.get(leftId)
    const right = nodeById.get(rightId)
    return (
      (left?.path ?? '').localeCompare(right?.path ?? '') ||
      (left?.label ?? '').localeCompare(right?.label ?? '') ||
      leftId.localeCompare(rightId)
    )
  }
  const parentById = new Map<string, string>()
  for (const node of nodes) {
    const parents = [...(incoming.get(node.id) ?? [])].sort(
      (left, right) =>
        (topology.ranks.get(right) ?? 0) - (topology.ranks.get(left) ?? 0) || nodeOrder(left, right)
    )
    const parent = parents[0]
    if (parent) parentById.set(node.id, parent)
  }

  const createsParentCycle = (child: string, parent: string): boolean => {
    let current: string | undefined = parent
    while (current) {
      if (current === child) return true
      current = parentById.get(current)
    }
    return false
  }
  for (const edge of edges) {
    if (!topology.cycleEdgeKeys.has(edgeIdentity(edge)) || parentById.has(edge.to)) continue
    if (!createsParentCycle(edge.to, edge.from)) parentById.set(edge.to, edge.from)
  }

  const childrenById = new Map(nodes.map((node) => [node.id, [] as string[]]))
  for (const [child, parent] of parentById) childrenById.get(parent)?.push(child)
  childrenById.forEach((children) => children.sort(nodeOrder))
  const roots = nodes
    .filter((node) => !parentById.has(node.id))
    .map((node) => node.id)
    .sort(
      (left, right) =>
        (topology.ranks.get(left) ?? 0) - (topology.ranks.get(right) ?? 0) || nodeOrder(left, right)
    )

  const nodeSpan = direction === 'vertical' ? 176 : 50
  const siblingGap = direction === 'vertical' ? 38 : 30
  const rootGap = direction === 'vertical' ? 72 : 56
  const branchSpan = new Map<string, number>()
  const measure = (id: string): number => {
    const children = childrenById.get(id) ?? []
    const childrenSpan = children.reduce(
      (total, child, index) => total + measure(child) + (index > 0 ? siblingGap : 0),
      0
    )
    const span = Math.max(nodeSpan, childrenSpan)
    branchSpan.set(id, span)
    return span
  }
  roots.forEach(measure)
  const forestSpan = roots.reduce(
    (total, root, index) => total + (branchSpan.get(root) ?? nodeSpan) + (index > 0 ? rootGap : 0),
    0
  )
  const positioned: PositionedNode[] = []
  let maximumDepth = 0
  const place = (id: string, start: number, depth: number): void => {
    const node = nodeById.get(id)
    if (!node) return
    const span = branchSpan.get(id) ?? nodeSpan
    const center = start + span / 2
    maximumDepth = Math.max(maximumDepth, depth)
    positioned.push({
      ...node,
      x: direction === 'vertical' ? center - 88 : 56 + depth * 250,
      y: direction === 'vertical' ? 48 + depth * 118 : center - 25,
    })
    const children = childrenById.get(id) ?? []
    const childrenSpan = children.reduce(
      (total, child, index) =>
        total + (branchSpan.get(child) ?? nodeSpan) + (index > 0 ? siblingGap : 0),
      0
    )
    let childStart = start + Math.max(0, (span - childrenSpan) / 2)
    for (const child of children) {
      place(child, childStart, depth + 1)
      childStart += (branchSpan.get(child) ?? nodeSpan) + siblingGap
    }
  }
  const minimumCrossAxis = direction === 'vertical' ? 848 : 470
  const crossAxisSize = Math.max(minimumCrossAxis, forestSpan + 112)
  let rootStart = Math.max(56, (crossAxisSize - forestSpan) / 2)
  for (const root of roots) {
    place(root, rootStart, 0)
    rootStart += (branchSpan.get(root) ?? nodeSpan) + rootGap
  }

  return direction === 'vertical'
    ? {
        nodes: positioned,
        lanes: [],
        width: Math.max(960, crossAxisSize),
        height: Math.max(560, (maximumDepth + 1) * 118 + 90),
      }
    : {
        nodes: positioned,
        lanes: [],
        width: Math.max(960, (maximumDepth + 1) * 250 + 100),
        height: Math.max(560, crossAxisSize),
      }
}

function positionNodes(
  nodes: readonly WorkbenchCodeGraphNode[],
  edges: readonly WorkbenchCodeGraphEdge[],
  topology: LogicGraphTopology,
  direction: LogicGraphDirection
): LogicGraphLayout {
  return positionDependencyTree(nodes, edges, topology, direction)
}

function edgeGeometry(
  from: PositionedNode,
  to: PositionedNode
): {
  path: string
  labelX: number
  labelY: number
} {
  const fromCenterX = from.x + 88
  const fromCenterY = from.y + 25
  const toCenterX = to.x + 88
  const toCenterY = to.y + 25
  const deltaX = toCenterX - fromCenterX
  const deltaY = toCenterY - fromCenterY

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    const direction = deltaX >= 0 ? 1 : -1
    const startX = fromCenterX + direction * 88
    const endX = toCenterX - direction * 91
    const bend = Math.max(42, Math.abs(endX - startX) * 0.42)
    return {
      path: `M ${startX} ${fromCenterY} C ${startX + bend * direction} ${fromCenterY}, ${endX - bend * direction} ${toCenterY}, ${endX} ${toCenterY}`,
      labelX: (startX + endX) / 2,
      labelY: (fromCenterY + toCenterY) / 2 - 8,
    }
  }

  const direction = deltaY >= 0 ? 1 : -1
  const startY = fromCenterY + direction * 25
  const endY = toCenterY - direction * 28
  const bend = Math.max(34, Math.abs(endY - startY) * 0.42)
  return {
    path: `M ${fromCenterX} ${startY} C ${fromCenterX} ${startY + bend * direction}, ${toCenterX} ${endY - bend * direction}, ${toCenterX} ${endY}`,
    labelX: (fromCenterX + toCenterX) / 2 + 9,
    labelY: (startY + endY) / 2,
  }
}

function compactGraphText(value: string, maximum = 24): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function dirtyOpenFiles(openTabs: readonly WorkbenchOpenEditorTab[]) {
  return openTabs
    .filter((tab) => tab.content !== tab.file.content)
    .slice(0, 16)
    .map((tab) => ({ path: tab.path, content: tab.content }))
}

function manifestEntryPath(content: string): Nullable<string> {
  try {
    const manifest = JSON.parse(content) as { entry?: unknown }
    if (typeof manifest.entry !== 'string') return null
    const path = manifest.entry.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (!path.endsWith('.vel') || path.startsWith('/') || path.split('/').includes('..'))
      return null
    return path
  } catch {
    return null
  }
}

function joinProjectPath(projectRoot: string, path: string): string {
  return projectRoot ? `${projectRoot}/${path}` : path
}

function pathMatchesScope(path: string, scopePaths: readonly string[]): boolean {
  if (scopePaths.length === 0) return true
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  return scopePaths.some((scope) => {
    const query = scope.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
    return normalized === query || normalized.startsWith(`${query}/`)
  })
}

function selectScopeNeighborhood(
  snapshot: VelarLogicGraphSnapshot,
  queries: readonly string[],
  maximumNodes: number
): Set<string> {
  const normalizedQueries = queries
    .map((query) => query.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean)
  const seeds = snapshot.nodes.filter((node) =>
    normalizedQueries.some((query) => {
      const path = node.path?.toLocaleLowerCase('en-US') ?? ''
      return (
        node.id.toLocaleLowerCase('en-US') === query ||
        node.name.toLocaleLowerCase('en-US') === query ||
        path === query ||
        path.startsWith(`${query}/`) ||
        node.context?.toLocaleLowerCase('en-US') === query
      )
    })
  )
  const symbolSelection =
    seeds.length > 0 &&
    normalizedQueries.every((query) =>
      seeds.some((node) => node.id.toLocaleLowerCase('en-US') === query)
    )
  const relationKinds = symbolSelection
    ? new Set(['calls', 'reads', 'writes', 'derives', 'crossesCapability'])
    : SelectionRelationKinds
  const maximumDepth = symbolSelection ? 12 : 1
  const selected = new Set<string>()
  const queue: Array<{ id: string; depth: number }> = []
  for (const node of seeds) {
    if (selected.size >= maximumNodes) break
    selected.add(node.id)
    queue.push({ id: node.id, depth: 0 })
  }
  const adjacent = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    if (!relationKinds.has(edge.kind)) continue
    adjacent.set(edge.from, [...(adjacent.get(edge.from) ?? []), edge.to])
    adjacent.set(edge.to, [...(adjacent.get(edge.to) ?? []), edge.from])
  }
  while (queue.length > 0 && selected.size < maximumNodes) {
    const current = queue.shift()
    if (!current || current.depth >= maximumDepth) continue
    for (const id of adjacent.get(current.id) ?? []) {
      if (selected.has(id)) continue
      selected.add(id)
      queue.push({ id, depth: current.depth + 1 })
      if (selected.size >= maximumNodes) break
    }
  }
  return selected
}

function selectModuleScope(
  snapshot: VelarLogicGraphSnapshot,
  queries: readonly string[],
  maximumNodes: number,
  cycleNodeIds: ReadonlySet<string>
): Set<string> {
  const normalizedQueries = queries
    .map((query) =>
      query.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase('en-US')
    )
    .filter(Boolean)
  const candidates = snapshot.nodes
    .filter((node) =>
      normalizedQueries.some((query) => {
        const path = node.path?.toLocaleLowerCase('en-US') ?? ''
        return (
          node.id.toLocaleLowerCase('en-US') === query ||
          path === query ||
          path.startsWith(`${query}/`)
        )
      })
    )
    .sort(
      (left, right) =>
        Number(cycleNodeIds.has(right.id)) - Number(cycleNodeIds.has(left.id)) ||
        (left.path ?? left.name).localeCompare(right.path ?? right.name)
    )
  return new Set(candidates.slice(0, maximumNodes).map((node) => node.id))
}

export function WorkbenchLogicGraphEditor({
  active,
  projectRoot,
  projectRoots,
  scopePaths,
  selectedFilePath,
  selectedContent,
  openTabs,
  projectFiles,
  projectSnapshots,
  refreshVersion,
  workbenchTheme,
  onProjectSnapshotsChange,
  onOpenSource,
}: WorkbenchLogicGraphEditorProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const runtime = useWorkbenchHostRuntime()
  const projectSnapshotsRef = useRef(projectSnapshots)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [layoutDirection, setLayoutDirection] = useState<LogicGraphDirection>('vertical')
  const [relationFilter, setRelationFilter] = useState<LogicGraphRelationFilter>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualNodePositions, setManualNodePositions] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [draggingNodeId, setDraggingNodeId] = useState<Nullable<string>>(null)
  const [panning, setPanning] = useState(false)
  const [selectedNodeCode, setSelectedNodeCode] = useState<Nullable<NodeCodeSnippet>>(null)
  const requestSequence = useRef(0)
  const nodeDragRef = useRef<Nullable<NodeDragState>>(null)
  const graphPanRef = useRef<Nullable<GraphPanState>>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const view: WorkbenchVelarStructureView = scopePaths.length > 0 ? 'selection' : 'overview'
  const targetProjectRoots = useMemo(
    () => selectWorkbenchVelarProjectRoots(projectRoots, scopePaths, null),
    [projectRoots, scopePaths]
  )
  const snapshotRoots = useMemo(
    () =>
      targetProjectRoots.length > 0
        ? targetProjectRoots
        : projectSnapshots.has('')
          ? ['']
          : [],
    [projectSnapshots, targetProjectRoots]
  )
  const snapshot = useMemo(
    () => mergeWorkbenchVelarProjectSnapshotIndex(projectSnapshots, snapshotRoots),
    [projectSnapshots, snapshotRoots]
  )

  useEffect(() => {
    projectSnapshotsRef.current = projectSnapshots
  }, [projectSnapshots])

  const load = useCallback(
    async (forceSnapshot = false): Promise<void> => {
      if (!active) return
      const sequence = ++requestSequence.current
      setLoading(true)
      setError(null)
      try {
        const candidatePaths = [
          ...(selectedFilePath?.endsWith('.vel') ? [selectedFilePath] : []),
          ...openTabs.filter((tab) => tab.path.endsWith('.vel')).map((tab) => tab.path),
          ...projectFiles.filter((file) => file.path.endsWith('.vel')).map((file) => file.path),
        ]
        const roots = targetProjectRoots.length > 0
          ? targetProjectRoots
          : [...new Set(candidatePaths
              .filter((path) => pathMatchesScope(path, scopePaths))
              .map((path) => workbenchVelarProjectRootForPath(path, projectRoots) ?? ''))]
        if (roots.length === 0) throw new Error(t('workbench.codeGraphEmpty'))

        const resolveEntry = async (root: string): Promise<string> => {
          const ownedPaths = candidatePaths.filter(
            (path) => {
              const owner = workbenchVelarProjectRootForPath(path, projectRoots)
              return owner === root || (owner === null && root === '')
            }
          )
          const candidate = ownedPaths.find((path) => pathMatchesScope(path, scopePaths))
            ?? ownedPaths[0]
          if (candidate) return candidate
          const manifestPath = joinProjectPath(root, 'velar.json')
          const manifest = Result.unwrap(await runtime.kernel.project.readWorkbenchFile({
            projectRoot,
            path: manifestPath,
            maxChars: 256_000,
          }))
          const entry = manifestEntryPath(manifest.content)
          if (!entry) throw new Error(t('workbench.codeGraphEmpty'))
          return joinProjectPath(root, entry)
        }

        const requestSnapshot = async (
          root: string,
          path: string,
          previous: VelarLogicGraphSnapshot | null
        ): Promise<VelarLogicGraphSnapshot> => {
          const activeTab = openTabs.find((tab) => tab.path === path)
          const response = await runtime.kernel.project.requestWorkbenchLanguageServiceExtension({
            projectRoot,
            path,
            language: 'velar',
            content:
              activeTab?.content ?? (selectedFilePath === path ? selectedContent : undefined),
            openFiles: dirtyOpenFiles(openTabs),
            requestId: VelarOwnershipGraphRequestId,
            parameters: {
              maximumNodes: 10_000,
              maximumEdges: 20_000,
              previousRevision: previous?.revision,
            },
          })
          if (!response.ok) throw response.error
          const parsed = parseVelarLogicGraphResponse(response.data.result)
          if (!parsed) throw new Error(t('workbench.codeGraphError'))
          const next = applyVelarLogicGraphResponse(previous, parsed)
          if (next) return next
          if (previous) return requestSnapshot(root, path, null)
          throw new Error(t('workbench.codeGraphError'))
        }

        const projects = await Promise.all(roots.map(async (root) => {
          const path = await resolveEntry(root)
          const previous = forceSnapshot ? null : projectSnapshotsRef.current.get(root) ?? null
          return { projectRoot: root, snapshot: await requestSnapshot(root, path, previous) }
        }))
        if (sequence !== requestSequence.current) return
        projectSnapshotsRef.current = new Map([
          ...projectSnapshotsRef.current,
          ...projects.map((project) => [project.projectRoot, project.snapshot] as const),
        ])
        onProjectSnapshotsChange(projects)
      } catch (reason) {
        if (sequence === requestSequence.current) {
          setError(reason instanceof Error ? reason.message : t('workbench.codeGraphError'))
        }
      } finally {
        if (sequence === requestSequence.current) setLoading(false)
      }
    },
    [
      active,
      openTabs,
      onProjectSnapshotsChange,
      projectRoot,
      projectRoots,
      projectFiles,
      runtime,
      scopePaths,
      selectedContent,
      selectedFilePath,
      t,
      targetProjectRoots,
    ]
  )

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => void load(), snapshot ? 120 : 0)
    return () => clearTimeout(timer)
  }, [active, load, refreshVersion])

  useEffect(() => {
    if (active) return
    requestSequence.current += 1
    setSelectedNodeId(null)
  }, [active])

  useEffect(() => {
    setSelectedNodeId(null)
    setManualNodePositions({})
  }, [scopePaths, view])

  const useSymbolProjection = useMemo(() => {
    if (!snapshot || view === 'overview') return false
    const symbolIds = new Set(
      snapshot.nodes.filter((node) => SelectionNodeKinds.has(node.kind)).map((node) => node.id)
    )
    return scopePaths.length === 1
      ? scopePaths[0]?.endsWith('.vel') === true || symbolIds.has(scopePaths[0] ?? '')
      : scopePaths.every((path) => symbolIds.has(path))
  }, [scopePaths, snapshot, view])
  const useModuleProjection = !useSymbolProjection

  const projectedSnapshot = useMemo(() => {
    if (!snapshot) return null
    const nodes = useModuleProjection
      ? snapshot.nodes.filter(
          (node) => node.kind === 'module' && !!node.path && isRelevantVelarPath(node.path)
        )
      : snapshot.nodes.filter(
          (node) =>
            SelectionNodeKinds.has(node.kind) &&
            (!node.path || isRelevantVelarPath(node.path))
        )
    const nodeIds = new Set(nodes.map((node) => node.id))
    const relationKinds = useModuleProjection ? OverviewRelationKinds : SelectionRelationKinds
    const seen = new Set<string>()
    const edges = snapshot.edges.filter((edge) => {
      if (!relationKinds.has(edge.kind) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
        return false
      const key = `${edge.kind}\u0000${edge.from}\u0000${edge.to}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { ...snapshot, nodes, edges }
  }, [snapshot, useModuleProjection])
  const projectedTopology = useMemo(
    () =>
      projectedSnapshot
        ? analyzeLogicGraphTopology(projectedSnapshot.nodes, projectedSnapshot.edges)
        : null,
    [projectedSnapshot]
  )

  const graph = useMemo(() => {
    if (!projectedSnapshot) return { nodes: [], edges: [], truncated: false }
    const limits = ViewLimits[view]
    const selected =
      view === 'overview'
        ? projectOverviewSelection(
            projectedSnapshot,
            limits.nodes,
            projectedTopology?.cycleNodeIds ?? new Set()
          )
        : useModuleProjection
          ? selectModuleScope(
              projectedSnapshot,
              scopePaths,
              limits.nodes,
              projectedTopology?.cycleNodeIds ?? new Set()
            )
          : selectScopeNeighborhood(projectedSnapshot, scopePaths, limits.nodes)
    const graphView = velarLogicGraphForWorkbench(projectRoot, projectedSnapshot, selected)
    const edges = deduplicateEdges(graphView.edges)
    const edgeTopology = analyzeLogicGraphTopology(graphView.nodes, edges)
    const orderedEdges = [...edges].sort(
      (left, right) =>
        Number(edgeTopology.cycleEdgeKeys.has(edgeIdentity(right))) -
        Number(edgeTopology.cycleEdgeKeys.has(edgeIdentity(left)))
    )
    return {
      nodes: graphView.nodes.map((node) =>
        useModuleProjection ? { ...node, label: node.path.split('/').at(-1) ?? node.label } : node
      ),
      edges: orderedEdges.slice(0, limits.edges),
      truncated: graphView.truncated || edges.length > limits.edges,
    }
  }, [projectRoot, projectedSnapshot, projectedTopology, scopePaths, useModuleProjection, view])
  const rootNodeIds = useMemo(
    () => new Set(scopePaths.filter((path) => graph.nodes.some((node) => node.id === path))),
    [graph.nodes, scopePaths]
  )
  const effectiveRelationFilter: LogicGraphRelationFilter = useModuleProjection
    ? 'imports'
    : relationFilter
  const relationFilterKinds = useMemo(() => {
    if (effectiveRelationFilter === 'all') return SelectionRelationKinds
    if (effectiveRelationFilter === 'data')
      return new Set(['reads', 'writes', 'derives', 'projectsReadonly'])
    if (effectiveRelationFilter === 'capability') return new Set(['crossesCapability'])
    return new Set([effectiveRelationFilter])
  }, [effectiveRelationFilter])
  const filteredGraphEdges = useMemo(
    () => graph.edges.filter((edge) => relationFilterKinds.has(edge.kind)),
    [graph.edges, relationFilterKinds]
  )
  const topology = useMemo(
    () => analyzeLogicGraphTopology(graph.nodes, filteredGraphEdges, rootNodeIds),
    [filteredGraphEdges, graph.nodes, rootNodeIds]
  )
  const layout = useMemo(
    () => positionNodes(graph.nodes, filteredGraphEdges, topology, layoutDirection),
    [filteredGraphEdges, graph.nodes, layoutDirection, topology]
  )
  const positionedNodes = useMemo(
    () =>
      layout.nodes.map((node) => ({
        ...node,
        ...(manualNodePositions[node.id] ?? {}),
      })),
    [layout.nodes, manualNodePositions]
  )
  const positionedById = useMemo(
    () => new Map(positionedNodes.map((node) => [node.id, node])),
    [positionedNodes]
  )
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null
  useEffect(() => {
    if (!selectedNode?.path) {
      setSelectedNodeCode(null)
      return
    }
    let cancelled = false
    const sourceNode = snapshot?.nodes.find((node) => node.id === selectedNode.id)
    const openContent =
      openTabs.find((tab) => tab.path === selectedNode.path)?.content ??
      (selectedFilePath === selectedNode.path ? selectedContent : null)
    const applyContent = (content: string): void => {
      if (!cancelled) {
        setSelectedNodeCode(nodeCodeSnippet(content, sourceNode?.range, selectedNode.line))
      }
    }
    if (openContent !== null && openContent !== undefined) {
      applyContent(openContent)
    } else {
      setSelectedNodeCode(null)
      void runtime.kernel.project
        .readWorkbenchFile({
          projectRoot,
          path: selectedNode.path,
          maxChars: 2_000_000,
        })
        .then((result) => applyContent(Result.unwrap(result).content))
        .catch(() => {
          if (!cancelled) setSelectedNodeCode(null)
        })
    }
    return () => {
      cancelled = true
    }
  }, [
    openTabs,
    projectRoot,
    runtime,
    selectedContent,
    selectedFilePath,
    selectedNode?.id,
    selectedNode?.line,
    selectedNode?.path,
    snapshot,
  ])
  const displayEdges = selectedNode
    ? filteredGraphEdges
        .filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id)
        .sort(
          (left, right) =>
            Number(topology.cycleEdgeKeys.has(edgeIdentity(right))) -
            Number(topology.cycleEdgeKeys.has(edgeIdentity(left)))
        )
        .slice(0, 24)
    : selectOverviewEdges(filteredGraphEdges, topology.cycleEdgeKeys)
  const visibleEdges = displayEdges.flatMap((edge) => {
    const from = positionedById.get(edge.from)
    const to = positionedById.get(edge.to)
    return from && to ? [{ edge, from, to }] : []
  })
  const relatedNodeIds = new Set<string>(
    selectedNode ? [selectedNode.id, ...displayEdges.flatMap((edge) => [edge.from, edge.to])] : []
  )
  const selectedRelations = selectedNode
    ? filteredGraphEdges
        .filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id)
        .sort(
          (left, right) =>
            Number(topology.cycleEdgeKeys.has(edgeIdentity(right))) -
            Number(topology.cycleEdgeKeys.has(edgeIdentity(left)))
        )
    : []
  const showEdgeLabels = selectedNode
    ? visibleEdges.length <= 10
    : view === 'selection' && graph.nodes.length <= 12
  const relationLabels: Record<string, string> = {
    imports: t('workbench.logicGraphRelationImports'),
    owns: t('workbench.logicGraphRelationOwns'),
    reads: t('workbench.logicGraphRelationReads'),
    writes: t('workbench.logicGraphRelationWrites'),
    derives: t('workbench.logicGraphRelationDerives'),
    calls: t('workbench.logicGraphRelationCalls'),
    crossesCapability: t('workbench.logicGraphRelationCapability'),
    projectsReadonly: t('workbench.logicGraphRelationReadonly'),
  }
  const nodeKindLabels: Record<string, string> = {
    module: t('workbench.logicGraphNodeKindModule'),
    component: t('workbench.logicGraphNodeKindComponent'),
    class: t('workbench.logicGraphNodeKindClass'),
    method: t('workbench.logicGraphNodeKindMethod'),
    type: t('workbench.logicGraphNodeKindType'),
    enum: t('workbench.logicGraphNodeKindEnum'),
    action: t('workbench.logicGraphNodeKindAction'),
    function: t('workbench.logicGraphNodeKindFunction'),
    state: t('workbench.logicGraphNodeKindState'),
    computed: t('workbench.logicGraphNodeKindComputed'),
    capability: t('workbench.logicGraphNodeKindCapability'),
    variable: t('workbench.logicGraphNodeKindVariable'),
    member: t('workbench.logicGraphNodeKindMember'),
    readonlyProjection: t('workbench.logicGraphNodeKindReadonly'),
  }

  const fitGraph = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport) return

    const horizontalScale = (viewport.clientWidth - 32) / layout.width
    setZoom(Math.max(0.78, Math.min(1, horizontalScale)))
    viewport.scrollTo({ left: 0, top: 0 })
  }, [layout.height, layout.width])

  useEffect(() => {
    if (!active || graph.nodes.length === 0) return
    const frame = window.requestAnimationFrame(fitGraph)
    return () => window.cancelAnimationFrame(frame)
  }, [active, fitGraph, graph.nodes.length, view])

  function handleGraphWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    const viewport = viewportRef.current
    if (!viewport) return
    const nextZoom = Math.max(0.55, Math.min(1.6, zoom + (event.deltaY < 0 ? 0.08 : -0.08)))
    const bounds = viewport.getBoundingClientRect()
    const offsetX = event.clientX - bounds.left
    const offsetY = event.clientY - bounds.top
    const graphX = (viewport.scrollLeft + offsetX) / zoom
    const graphY = (viewport.scrollTop + offsetY) / zoom
    setZoom(nextZoom)
    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        left: graphX * nextZoom - offsetX,
        top: graphY * nextZoom - offsetY,
      })
    })
  }

  function handleGraphPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 && event.button !== 1) return
    if ((event.target as Element).closest(`.${styles.logicGraphNodes}`)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    graphPanRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    }
    setPanning(true)
  }

  function handleGraphPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = graphPanRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX)
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.clientY)
  }

  function finishGraphPan(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = graphPanRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    graphPanRef.current = null
    setPanning(false)
  }

  async function openSource(path: string, line?: number, column?: number): Promise<void> {
    try {
      const result = await runtime.kernel.project.readWorkbenchFile({
        projectRoot,
        path,
        maxChars: 2_000_000,
      })
      onOpenSource({
        path,
        content: Result.unwrap(result).content,
        line,
        column,
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('workbench.codeGraphError'))
    }
  }

  function handleNodePointerDown(
    event: ReactPointerEvent<SVGGElement>,
    node: PositionedNode
  ): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    nodeDragRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: node.x,
      y: node.y,
      moved: false,
    }
    setDraggingNodeId(node.id)
  }

  function handleNodePointerMove(event: ReactPointerEvent<SVGGElement>): void {
    const drag = nodeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.clientX
    const deltaY = event.clientY - drag.clientY
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return
    drag.moved = true
    const x = Math.max(8, Math.min(layout.width - 184, drag.x + deltaX / zoom))
    const y = Math.max(8, Math.min(layout.height - 58, drag.y + deltaY / zoom))
    setManualNodePositions((current) => ({
      ...current,
      [drag.nodeId]: { x, y },
    }))
  }

  function finishNodeDrag(event: ReactPointerEvent<SVGGElement>): void {
    const drag = nodeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (event.type === 'pointerup' && !drag.moved) setSelectedNodeId(drag.nodeId)
    nodeDragRef.current = null
    setDraggingNodeId(null)
  }

  return (
    <section className={styles.logicGraphEditor}>
      <div
        className={styles.logicGraphEditorStage}
        data-inspector-open={!!selectedNode || undefined}
      >
        <div className={styles.logicGraphFloatingActions}>
          {!useModuleProjection && (
            <Select<LogicGraphRelationFilter>
              size="xs"
              className={styles.logicGraphRelationSelect}
              value={relationFilter}
              options={[
                { value: 'all', label: t('workbench.logicGraphRelationsAll') },
                {
                  value: 'calls',
                  label: t('workbench.logicGraphRelationsCalls'),
                },
                {
                  value: 'data',
                  label: t('workbench.logicGraphRelationsData'),
                },
                {
                  value: 'owns',
                  label: t('workbench.logicGraphRelationsOwns'),
                },
                {
                  value: 'capability',
                  label: t('workbench.logicGraphRelationsCapability'),
                },
              ]}
              onChange={(filter) => {
                setRelationFilter(filter)
                setManualNodePositions({})
              }}
            />
          )}
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={t(
              layoutDirection === 'vertical'
                ? 'workbench.logicGraphHorizontalView'
                : 'workbench.logicGraphVerticalView'
            )}
            title={t(
              layoutDirection === 'vertical'
                ? 'workbench.logicGraphHorizontalView'
                : 'workbench.logicGraphVerticalView'
            )}
            onClick={() => {
              setManualNodePositions({})
              setLayoutDirection((current) => (current === 'vertical' ? 'horizontal' : 'vertical'))
            }}
          >
            {layoutDirection === 'vertical' ? (
              <ArrowsLeftRightIcon size={15} />
            ) : (
              <ArrowsDownUpIcon size={15} />
            )}
          </IconButton>
          {selectedNode?.path && (
            <IconButton
              variant="ghost"
              size="icon-sm"
              label={t('workbench.logicGraphOpenSource')}
              title={t('workbench.logicGraphOpenSource')}
              onClick={() =>
                void openSource(selectedNode.path, selectedNode.line, selectedNode.column)
              }
            >
              <ArrowSquareOutIcon size={15} />
            </IconButton>
          )}
        </div>
        <div
          ref={viewportRef}
          className={styles.logicGraphViewport}
          data-panning={panning || undefined}
          onWheel={handleGraphWheel}
          onPointerDown={handleGraphPointerDown}
          onPointerMove={handleGraphPointerMove}
          onPointerUp={finishGraphPan}
          onPointerCancel={finishGraphPan}
        >
          {error ? (
            <div className={styles.logicGraphMessage}>{error}</div>
          ) : !loading && graph.nodes.length === 0 ? (
            <div className={styles.logicGraphMessage}>{t('workbench.codeGraphEmpty')}</div>
          ) : (
            <svg
              className={styles.logicGraphCanvas}
              width={layout.width * zoom}
              height={layout.height * zoom}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={t('workbench.velarLogicGraphTitle')}
              data-view={view}
            >
              <defs>
                <marker
                  id="logic-graph-arrow"
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  <path d="M 1 0.75 L 6 3.5 L 1 6.25" />
                </marker>
              </defs>
              {layout.lanes.length > 0 && (
                <g className={styles.logicGraphContextLanes}>
                  {layout.lanes.map((lane) => (
                    <g key={lane.name}>
                      <rect
                        x="18"
                        y={lane.y}
                        width={layout.width - 36}
                        height={lane.height}
                        rx="6"
                      />
                      <text x="32" y={lane.y + 23}>
                        {compactGraphText(lane.name, 42)}
                      </text>
                      <title>{lane.name}</title>
                    </g>
                  ))}
                </g>
              )}
              <g className={styles.logicGraphEdges}>
                {visibleEdges.map(({ edge, from, to }) => (
                  <g key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`}>
                    <path
                      key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`}
                      d={edgeGeometry(from, to).path}
                      markerEnd="url(#logic-graph-arrow)"
                      data-kind={edge.kind}
                      data-active={!!selectedNode}
                      data-cycle={topology.cycleEdgeKeys.has(edgeIdentity(edge)) || undefined}
                    >
                      <title>{relationLabels[edge.kind] ?? edge.kind}</title>
                    </path>
                    {showEdgeLabels && (
                      <text x={edgeGeometry(from, to).labelX} y={edgeGeometry(from, to).labelY}>
                        {relationLabels[edge.kind] ?? edge.kind}
                      </text>
                    )}
                  </g>
                ))}
              </g>
              <g className={styles.logicGraphNodes}>
                {positionedNodes.map((node) => (
                  <g
                    key={node.id}
                    transform={`translate(${node.x} ${node.y})`}
                    data-kind={node.kind}
                    data-selected={node.id === selectedNodeId}
                    data-related={selectedNode ? relatedNodeIds.has(node.id) : undefined}
                    data-dragging={draggingNodeId === node.id || undefined}
                    data-cycle={topology.cycleNodeIds.has(node.id) || undefined}
                    tabIndex={0}
                    role="button"
                    onPointerDown={(event) => handleNodePointerDown(event, node)}
                    onPointerMove={handleNodePointerMove}
                    onPointerUp={finishNodeDrag}
                    onPointerCancel={finishNodeDrag}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedNodeId(node.id)
                      }
                    }}
                    onDoubleClick={() => {
                      if (node.path) void openSource(node.path, node.line, node.column)
                    }}
                  >
                    <rect width="176" height="50" rx="6" />
                    <text x="12" y="20" className={styles.logicGraphNodeTitle}>
                      {compactGraphText(node.label)}
                    </text>
                    <text x="12" y="38" className={styles.logicGraphNodeMeta}>
                      {compactGraphText(
                        node.kind === 'module'
                          ? node.path.split('/').slice(0, -1).join('/') ||
                              t('workbench.logicGraphProjectRoot')
                          : node.context
                            ? `${nodeKindLabels[node.kind] ?? node.kind} · ${node.context}`
                            : (nodeKindLabels[node.kind] ?? node.kind),
                        28
                      )}
                    </text>
                    <title>{node.path || node.label}</title>
                  </g>
                ))}
              </g>
            </svg>
          )}
        </div>
        {selectedNode && (
          <aside className={styles.logicGraphInspector}>
            <div className={styles.logicGraphInspectorHeader}>
              <div className={styles.logicGraphDetailHeading}>
                <span>{nodeKindLabels[selectedNode.kind] ?? selectedNode.kind}</span>
                <strong>{selectedNode.label}</strong>
              </div>
              <IconButton
                variant="ghost"
                size="icon-sm"
                label={t('common.close')}
                title={t('common.close')}
                onClick={() => setSelectedNodeId(null)}
              >
                <XIcon size={14} />
              </IconButton>
            </div>
            {topology.cycleNodeIds.has(selectedNode.id) && (
              <span className={styles.logicGraphCycleBadge}>
                {t('workbench.logicGraphCircularDependency')}
              </span>
            )}
            {selectedNode.path && <code>{selectedNode.path}</code>}
            {selectedNode.context && (
              <div className={styles.logicGraphDetailContext}>
                {t('workbench.logicGraphBusinessContext')}: {selectedNode.context}
              </div>
            )}
            {selectedNode.type && (
              <div className={styles.logicGraphDetailSignature}>
                <ReadOnlyWorkbenchCode
                  content={selectedNode.type}
                  path={selectedNode.path}
                  workbenchTheme={workbenchTheme}
                  showLineNumbers={false}
                  compact
                />
              </div>
            )}
            {selectedNode.documentation && <p>{selectedNode.documentation}</p>}
            {selectedNodeCode && (
              <section className={styles.logicGraphCodePreview}>
                <span>{t('workbench.logicGraphSourcePreview')}</span>
                <div className={styles.logicGraphCodeViewer}>
                  <ReadOnlyWorkbenchCode
                    content={selectedNodeCode.code}
                    path={selectedNode.path}
                    workbenchTheme={workbenchTheme}
                    showLineNumbers={false}
                    compact
                  />
                </div>
                <small>
                  {t('workbench.logicGraphSourceLine', {
                    line: selectedNodeCode.startLine,
                  })}
                  {selectedNodeCode.truncated ? ` · ${t('workbench.codeGraphTruncated')}` : ''}
                </small>
              </section>
            )}
            <div className={styles.logicGraphRelationList}>
              {selectedRelations.slice(0, 24).map((edge) => {
                const incoming = edge.to === selectedNode.id
                const other = positionedById.get(incoming ? edge.from : edge.to)
                return (
                  <button
                    key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`}
                    onClick={() => setSelectedNodeId(other?.id ?? null)}
                  >
                    <span>
                      {incoming ? <ArrowLeftIcon size={12} /> : <ArrowRightIcon size={12} />}
                      {relationLabels[edge.kind] ?? edge.kind}
                    </span>
                    <strong>{other?.label ?? (incoming ? edge.from : edge.to)}</strong>
                  </button>
                )
              })}
            </div>
          </aside>
        )}
      </div>
      <footer className={styles.logicGraphEditorStatus}>
        <span>
          {t('workbench.codeGraphNodes', {
            nodes: graph.nodes.length,
            edges: filteredGraphEdges.length,
          })}
        </span>
        {topology.cycleCount > 0 && (
          <span data-warning="true">
            {t('workbench.logicGraphCircularDependencyCount', {
              count: topology.cycleCount,
            })}
          </span>
        )}
        {graph.truncated && <span>{t('workbench.codeGraphTruncated')}</span>}
        <span>{Math.round(zoom * 100)}%</span>
      </footer>
    </section>
  )
}
