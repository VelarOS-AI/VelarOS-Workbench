import { isBoolean, optionalWhen } from '@velaros-ai/core'

import type {
  WorkbenchCodeGraphEdge,
  WorkbenchCodeGraphNode,
  WorkbenchGetCodeGraphResult,
} from '@shared/contracts'

export const VelarOwnershipGraphRequestId = 'ownership-graph'

export interface VelarLogicGraphPosition {
  line: number
  character: number
}

export interface VelarLogicGraphRange {
  start: VelarLogicGraphPosition
  end: VelarLogicGraphPosition
}

export interface VelarLogicGraphNode {
  id: string
  kind: string
  name: string
  documentation?: string
  context?: string
  type?: string
  exported?: boolean
  mutable?: boolean
  path?: string
  uri?: string
  range?: VelarLogicGraphRange
  selectionRange?: VelarLogicGraphRange
}

export interface VelarLogicGraphEdge {
  id: string
  kind: string
  from: string
  to: string
  path?: string
  uri?: string
  range?: VelarLogicGraphRange
}

export interface VelarLogicGraphCoverage {
  modulesTotal: number
  modulesIncluded: number
  complete: boolean
  callRelations: string
  memberCallRelations: boolean
}

export interface VelarLogicGraphActivity {
  strategy: 'full' | 'affected-modules'
  modulesVisited: number
}

export interface VelarLogicGraphResponse {
  protocolVersion: 1
  mode: 'snapshot' | 'patch'
  rootUri: string
  revision: string
  baseRevision?: string
  nodes: VelarLogicGraphNode[]
  edges: VelarLogicGraphEdge[]
  removedNodeIds: string[]
  removedEdgeIds: string[]
  coverage: VelarLogicGraphCoverage
  limitReached: boolean
  durationMs: number
  activity: VelarLogicGraphActivity
}

export interface VelarLogicGraphSnapshot
  extends Omit<VelarLogicGraphResponse, 'mode' | 'baseRevision' | 'removedNodeIds' | 'removedEdgeIds'> {
  mode: 'snapshot'
}

const MaximumGraphNodes = 20_000
const MaximumGraphEdges = 40_000

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function position(value: unknown): VelarLogicGraphPosition | null {
  const item = record(value)
  const line = nonNegativeInteger(item?.['line'])
  const character = nonNegativeInteger(item?.['character'])
  return line === null || character === null ? null : { line, character }
}

function range(value: unknown): VelarLogicGraphRange | undefined {
  const item = record(value)
  const start = position(item?.['start'])
  const end = position(item?.['end'])
  return start && end ? { start, end } : undefined
}

function boundedText(
  item: Record<string, unknown>,
  key: string,
  maximumLength: number,
  required = false
): string | null | undefined {
  const value = item[key]
  if (value === undefined && !required) return undefined
  return typeof value === 'string' && value.length <= maximumLength ? value : null
}

function relativeGraphPath(item: Record<string, unknown>): string | null | undefined {
  const value = boundedText(item, 'path', 8_192)
  if (value === undefined || value === null) return value
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//iu.test(normalized)
    || normalized.split('/').includes('..')) return null
  return normalized
}

function graphNode(value: unknown): VelarLogicGraphNode | null {
  const item = record(value)
  if (!item) return null
  const id = boundedText(item, 'id', 1_024, true)
  const kind = boundedText(item, 'kind', 128, true)
  const name = boundedText(item, 'name', 4_096, true)
  const documentation = boundedText(item, 'documentation', 32_768)
  const context = boundedText(item, 'context', 256)
  const type = boundedText(item, 'type', 16_384)
  const path = relativeGraphPath(item)
  const uri = boundedText(item, 'uri', 16_384)
  if (!id || !kind || !name || documentation === null || context === null || type === null
    || path === null || uri === null) return null
  const declarationRange = range(item['range'])
  const selectionRange = range(item['selectionRange'])
  return {
    id,
    kind,
    name,
    documentation,
    context,
    type,
    path,
    uri,
    exported: optionalWhen(isBoolean, item['exported']),
    mutable: optionalWhen(isBoolean, item['mutable']),
    range: declarationRange,
    selectionRange,
  }
}

function graphEdge(value: unknown): VelarLogicGraphEdge | null {
  const item = record(value)
  if (!item) return null
  const id = boundedText(item, 'id', 1_024, true)
  const kind = boundedText(item, 'kind', 128, true)
  const from = boundedText(item, 'from', 1_024, true)
  const to = boundedText(item, 'to', 1_024, true)
  const path = relativeGraphPath(item)
  const uri = boundedText(item, 'uri', 16_384)
  if (!id || !kind || !from || !to || path === null
    || uri === null) return null
  const edgeRange = range(item['range'])
  return {
    id,
    kind,
    from,
    to,
    path,
    uri,
    range: edgeRange,
  }
}

function stringList(value: unknown, maximum: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximum
    || value.some((item) => typeof item !== 'string')) return null
  return value as string[]
}

export function parseVelarLogicGraphResponse(value: unknown): VelarLogicGraphResponse | null {
  const item = record(value)
  if (!item || item['protocolVersion'] !== 1
    || (item['mode'] !== 'snapshot' && item['mode'] !== 'patch')
    || typeof item['rootUri'] !== 'string' || typeof item['revision'] !== 'string'
    || !/^[a-f0-9]{64}$/u.test(item['revision'])
    || !Array.isArray(item['nodes']) || item['nodes'].length > MaximumGraphNodes
    || !Array.isArray(item['edges']) || item['edges'].length > MaximumGraphEdges) return null
  const nodes = item['nodes'].map(graphNode)
  const edges = item['edges'].map(graphEdge)
  if (nodes.includes(null) || edges.includes(null)) return null
  const parsedNodes = nodes as VelarLogicGraphNode[]
  const parsedEdges = edges as VelarLogicGraphEdge[]
  if (new Set(parsedNodes.map((node) => node.id)).size !== parsedNodes.length
    || new Set(parsedEdges.map((edge) => edge.id)).size !== parsedEdges.length) return null
  const coverage = record(item['coverage'])
  const activity = record(item['activity'])
  const modulesTotal = nonNegativeInteger(coverage?.['modulesTotal'])
  const modulesIncluded = nonNegativeInteger(coverage?.['modulesIncluded'])
  const durationMs = finiteNumber(item['durationMs'])
  const modulesVisited = nonNegativeInteger(activity?.['modulesVisited'])
  if (!coverage || modulesTotal === null || modulesIncluded === null
    || typeof coverage['complete'] !== 'boolean'
    || typeof coverage['callRelations'] !== 'string'
    || typeof coverage['memberCallRelations'] !== 'boolean'
    || !activity || (activity['strategy'] !== 'full' && activity['strategy'] !== 'affected-modules')
    || modulesVisited === null || durationMs === null || typeof item['limitReached'] !== 'boolean') return null
  const removedNodeIds = stringList(item['removedNodeIds'] ?? [], MaximumGraphNodes)
  const removedEdgeIds = stringList(item['removedEdgeIds'] ?? [], MaximumGraphEdges)
  if (!removedNodeIds || !removedEdgeIds) return null
  if (item['mode'] === 'patch' && (typeof item['baseRevision'] !== 'string'
    || !/^[a-f0-9]{64}$/u.test(item['baseRevision']))) return null
  return {
    protocolVersion: 1,
    mode: item['mode'],
    rootUri: item['rootUri'],
    revision: item['revision'],
    baseRevision: optionalWhen(item['mode'] === 'patch', item['baseRevision'] as string),
    nodes: parsedNodes,
    edges: parsedEdges,
    removedNodeIds,
    removedEdgeIds,
    coverage: {
      modulesTotal,
      modulesIncluded,
      complete: coverage['complete'],
      callRelations: coverage['callRelations'],
      memberCallRelations: coverage['memberCallRelations'],
    },
    limitReached: item['limitReached'],
    durationMs,
    activity: {
      strategy: activity['strategy'],
      modulesVisited,
    },
  }
}

export function applyVelarLogicGraphResponse(
  previous: VelarLogicGraphSnapshot | null,
  response: VelarLogicGraphResponse
): VelarLogicGraphSnapshot | null {
  if (response.mode === 'snapshot') return {
    protocolVersion: 1,
    mode: 'snapshot',
    rootUri: response.rootUri,
    revision: response.revision,
    nodes: response.nodes,
    edges: response.edges,
    coverage: response.coverage,
    limitReached: response.limitReached,
    durationMs: response.durationMs,
    activity: response.activity,
  }
  if (!previous || response.baseRevision !== previous.revision) return null
  const removedNodes = new Set(response.removedNodeIds)
  const removedEdges = new Set(response.removedEdgeIds)
  const nodes = new Map(previous.nodes
    .filter((node) => !removedNodes.has(node.id))
    .map((node) => [node.id, node]))
  const edges = new Map(previous.edges
    .filter((edge) => !removedEdges.has(edge.id))
    .map((edge) => [edge.id, edge]))
  for (const node of response.nodes) nodes.set(node.id, node)
  for (const edge of response.edges) edges.set(edge.id, edge)
  const retainedNodeIds = new Set(nodes.keys())
  return {
    protocolVersion: 1,
    mode: 'snapshot',
    rootUri: response.rootUri,
    revision: response.revision,
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter(
      (edge) => retainedNodeIds.has(edge.from) && retainedNodeIds.has(edge.to)
    ),
    coverage: response.coverage,
    limitReached: response.limitReached,
    durationMs: response.durationMs,
    activity: response.activity,
  }
}

export function velarLogicGraphForWorkbench(
  projectRoot: string,
  snapshot: VelarLogicGraphSnapshot,
  selectedNodeIds?: ReadonlySet<string>
): WorkbenchGetCodeGraphResult {
  const selected = selectedNodeIds ?? new Set(snapshot.nodes.map((node) => node.id))
  const nodes: WorkbenchCodeGraphNode[] = snapshot.nodes
    .filter((node) => selected.has(node.id))
    .map((node) => ({
      id: node.id,
      label: node.name,
      path: node.path ?? '',
      language: 'velar',
      kind: node.kind,
      documentation: node.documentation,
      context: node.context,
      type: node.type,
      exported: node.exported,
      mutable: node.mutable,
      ...(node.selectionRange ? {
        line: node.selectionRange.start.line + 1,
        column: node.selectionRange.start.character + 1,
      } : {}),
    }))
  const edges: WorkbenchCodeGraphEdge[] = snapshot.edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind }))
  return {
    projectRoot,
    mode: selectedNodeIds ? 'local' : 'full',
    nodes,
    edges,
    truncated: snapshot.limitReached || !snapshot.coverage.complete,
  }
}

export function selectVelarLogicGraphNeighborhood(
  snapshot: VelarLogicGraphSnapshot,
  focus: string,
  depth = 2,
  maximumNodes = 240,
  options: {
    direction?: 'incoming' | 'outgoing' | 'both'
    relationKinds?: ReadonlySet<string>
  } = {}
): Set<string> {
  const boundedDepth = Math.min(8, Math.max(0, Math.floor(depth)))
  const boundedMaximumNodes = Math.min(MaximumGraphNodes, Math.max(0, Math.floor(maximumNodes)))
  const query = focus.trim().toLocaleLowerCase('en-US')
  const starts = snapshot.nodes.filter((node) => node.id.toLocaleLowerCase('en-US') === query
    || node.name.toLocaleLowerCase('en-US') === query
    || node.path?.toLocaleLowerCase('en-US') === query
    || node.context?.toLocaleLowerCase('en-US') === query)
  const candidates = starts.length > 0 ? starts : snapshot.nodes.filter((node) =>
    node.name.toLocaleLowerCase('en-US').includes(query)
    || node.path?.toLocaleLowerCase('en-US').includes(query)
    || node.context?.toLocaleLowerCase('en-US').includes(query))
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    if (options.relationKinds && !options.relationKinds.has(edge.kind)) continue
    const from = outgoing.get(edge.from) ?? []
    from.push(edge.to)
    outgoing.set(edge.from, from)
    const to = incoming.get(edge.to) ?? []
    to.push(edge.from)
    incoming.set(edge.to, to)
  }
  const selected = new Set<string>()
  const pending = candidates.map((node) => ({ id: node.id, depth: 0 }))
  for (let cursor = 0; cursor < pending.length && selected.size < boundedMaximumNodes; cursor += 1) {
    const current = pending[cursor]!
    if (selected.has(current.id)) continue
    selected.add(current.id)
    if (current.depth >= boundedDepth) continue
    const neighbors = options.direction === 'incoming'
      ? incoming.get(current.id) ?? []
      : options.direction === 'outgoing'
        ? outgoing.get(current.id) ?? []
        : [...(outgoing.get(current.id) ?? []), ...(incoming.get(current.id) ?? [])]
    for (const id of neighbors) {
      if (!selected.has(id)) pending.push({ id, depth: current.depth + 1 })
    }
  }
  return selected
}
