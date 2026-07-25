import type { WorkbenchCodeGraphEdge, WorkbenchCodeGraphNode } from '@velaros/core/types'

export interface WorkbenchCodeGraphPosition {
  x: number
  y: number
  vx: number
  vy: number
}

export interface WorkbenchCodeGraphSimNode extends WorkbenchCodeGraphPosition {
  id: string
  degree: number
}

export interface WorkbenchCodeGraphLayoutInput {
  nodes: WorkbenchCodeGraphNode[]
  edges: WorkbenchCodeGraphEdge[]
  centerId: Nullable<string>
  previousPositions: ReadonlyMap<string, WorkbenchCodeGraphPosition>
}

export interface WorkbenchCodeGraphLayoutResult {
  nodes: Map<string, WorkbenchCodeGraphSimNode>
  restoredCount: number
}

export interface WorkbenchCodeGraphRepulsionPair {
  source: WorkbenchCodeGraphSimNode
  target: WorkbenchCodeGraphSimNode
}

export interface WorkbenchCodeGraphRepulsionOptions {
  cellSize?: number
  maxNeighborsPerNode?: number
}

const REPULSION_GRID_CELL_SIZE = 140
const MAX_VISIBLE_CODE_GRAPH_LABELS = 90
export const MAX_REPULSION_NEIGHBORS_PER_NODE = 22

function getDegreeById(edges: WorkbenchCodeGraphEdge[]): Map<string, number> {
  const degreeById = new Map<string, number>()
  for (const edge of edges) {
    degreeById.set(edge.from, (degreeById.get(edge.from) ?? 0) + 1)
    degreeById.set(edge.to, (degreeById.get(edge.to) ?? 0) + 1)
  }
  return degreeById
}

function createFallbackPosition(index: number, count: number): WorkbenchCodeGraphPosition {
  const angle = (index / Math.max(1, count)) * Math.PI * 2
  const ring = 40 + (index % 12) * 26
  return {
    x: Math.cos(angle) * ring,
    y: Math.sin(angle) * ring,
    vx: 0,
    vy: 0,
  }
}

export function buildWorkbenchCodeGraphSimNodes(
  input: WorkbenchCodeGraphLayoutInput
): WorkbenchCodeGraphLayoutResult {
  const degreeById = getDegreeById(input.edges)
  const sim = new Map<string, WorkbenchCodeGraphSimNode>()
  let restoredCount = 0

  input.nodes.forEach((node, index) => {
    const cached = input.previousPositions.get(node.id)
    const isCenter = input.centerId === node.id
    const position =
      cached && !isCenter ? cached : createFallbackPosition(index, input.nodes.length)
    if (cached && !isCenter) {
      restoredCount += 1
    }

    sim.set(node.id, {
      id: node.id,
      x: isCenter ? 0 : position.x,
      y: isCenter ? 0 : position.y,
      vx: isCenter ? 0 : position.vx,
      vy: isCenter ? 0 : position.vy,
      degree: degreeById.get(node.id) ?? 0,
    })
  })

  return { nodes: sim, restoredCount }
}

function bucketKey(x: number, y: number): string {
  return `${x}:${y}`
}

export function buildWorkbenchCodeGraphRepulsionPairs(
  nodes: readonly WorkbenchCodeGraphSimNode[],
  options: WorkbenchCodeGraphRepulsionOptions = {}
): WorkbenchCodeGraphRepulsionPair[] {
  const cellSize = Math.max(1, options.cellSize ?? REPULSION_GRID_CELL_SIZE)
  const maxNeighborsPerNode = Math.max(
    1,
    options.maxNeighborsPerNode ?? MAX_REPULSION_NEIGHBORS_PER_NODE
  )
  const buckets = new Map<string, WorkbenchCodeGraphSimNode[]>()
  for (const node of nodes) {
    const bucketX = Math.floor(node.x / cellSize)
    const bucketY = Math.floor(node.y / cellSize)
    const key = bucketKey(bucketX, bucketY)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(node)
    } else {
      buckets.set(key, [node])
    }
  }

  const pairs: WorkbenchCodeGraphRepulsionPair[] = []
  for (const node of nodes) {
    const bucketX = Math.floor(node.x / cellSize)
    const bucketY = Math.floor(node.y / cellSize)
    let added = 0

    for (let offsetX = -1; offsetX <= 1 && added < maxNeighborsPerNode; offsetX++) {
      for (let offsetY = -1; offsetY <= 1 && added < maxNeighborsPerNode; offsetY++) {
        const bucket = buckets.get(bucketKey(bucketX + offsetX, bucketY + offsetY))
        if (!bucket) continue

        for (const target of bucket) {
          if (target.id === node.id) continue
          pairs.push({ source: node, target })
          added += 1
          if (added >= maxNeighborsPerNode) break
        }
      }
    }
  }

  return pairs
}

export function resolveWorkbenchCodeGraphVisibleLabelIds(
  nodes: Iterable<WorkbenchCodeGraphSimNode>,
  centerId: Nullable<string>,
  maxLabels = MAX_VISIBLE_CODE_GRAPH_LABELS
): Set<string> {
  const visible = new Set<string>()
  if (centerId) {
    visible.add(centerId)
  }

  const ranked = [...nodes].sort((left, right) => {
    const degreeDelta = right.degree - left.degree
    return degreeDelta === 0 ? left.id.localeCompare(right.id, 'en') : degreeDelta
  })

  for (const node of ranked) {
    if (visible.size >= maxLabels) break
    visible.add(node.id)
  }

  return visible
}
