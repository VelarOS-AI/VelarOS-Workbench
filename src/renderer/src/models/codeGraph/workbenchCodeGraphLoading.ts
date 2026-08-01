import type {
  AppResourcePluginCatalog,
  WorkbenchCodeGraphEdge,
  WorkbenchGetCodeGraphResult,
} from '@shared/contracts'

const CODE_GRAPH_FULL_MAX_NODES = 400
const CODE_GRAPH_INITIAL_MAX_NODES = 120
const CODE_GRAPH_IDLE_TIMEOUT_MS = 800

function edgeKey(edge: WorkbenchCodeGraphEdge): string {
  return `${edge.from}\t${edge.to}\t${edge.kind}`
}

export function isCodeGraphResourceAvailable(catalog: AppResourcePluginCatalog): boolean {
  return catalog.plugins.some((plugin) => plugin.id === 'codegraph' && plugin.status === 'available')
}

export function resolveInitialCodeGraphMaxNodes(fullMaxNodes = CODE_GRAPH_FULL_MAX_NODES): number {
  return Math.min(fullMaxNodes, CODE_GRAPH_INITIAL_MAX_NODES)
}

export function mergeWorkbenchCodeGraphBatches(
  initial: WorkbenchGetCodeGraphResult,
  full: WorkbenchGetCodeGraphResult
): WorkbenchGetCodeGraphResult {
  const fullNodesById = new Map(full.nodes.map((node) => [node.id, node]))
  const seenNodeIds = new Set<string>()
  const nodes = initial.nodes.map((node) => {
    seenNodeIds.add(node.id)
    return fullNodesById.get(node.id) ?? node
  })

  for (const node of full.nodes) {
    if (seenNodeIds.has(node.id)) {
      continue
    }
    seenNodeIds.add(node.id)
    nodes.push(node)
  }

  const seenEdgeKeys = new Set<string>()
  const edges: WorkbenchCodeGraphEdge[] = []
  const addEdge = (edge: WorkbenchCodeGraphEdge): void => {
    const key = edgeKey(edge)
    if (seenEdgeKeys.has(key)) return
    seenEdgeKeys.add(key)
    edges.push(edge)
  }

  for (const edge of initial.edges) {
    addEdge(edge)
  }
  for (const edge of full.edges) {
    addEdge(edge)
  }

  return {
    ...full,
    nodes,
    edges,
  }
}

export { CODE_GRAPH_FULL_MAX_NODES, CODE_GRAPH_IDLE_TIMEOUT_MS }
