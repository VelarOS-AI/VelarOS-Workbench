/**
 * 调用层次面板的纯逻辑：一棵按需展开的树。根是光标处的函数，它下面是调用它的（或它调用的）函数，再往下一层
 * 在展开时才去问语言服务。请求、跳转和呈现在编辑器组件那边。
 */
import type {
  WorkbenchLanguageServiceCallHierarchyCall,
  WorkbenchLanguageServiceCallHierarchyDirection,
  WorkbenchLanguageServiceCallHierarchyItem,
  WorkbenchLanguageServiceLocation,
} from '@shared/contracts'

export interface WorkbenchCallHierarchyNode {
  id: string
  /** 上一层；根为 null。 */
  parentId: Nullable<string>
  item: WorkbenchLanguageServiceCallHierarchyItem
  /** 它与上一层之间的调用发生在哪几处；根没有。 */
  sites: readonly WorkbenchLanguageServiceLocation[]
  depth: number
  expanded: boolean
  /** 下一层：null 是还没问过（或正在问，见 `loading`）。 */
  childIds: Nullable<readonly string[]>
  loading: boolean
  /** 问下一层没问到的说明。 */
  error: Nullable<string>
  /** 这一支往上已经有它了（递归、互相调用）：到此为止，不再往下展开。 */
  recursive: boolean
}

export interface WorkbenchCallHierarchyState {
  direction: WorkbenchLanguageServiceCallHierarchyDirection
  rootId: string
  nodes: ReadonlyMap<string, WorkbenchCallHierarchyNode>
}

const RootId = 'root'

function itemIdentity(item: WorkbenchLanguageServiceCallHierarchyItem): string {
  return `${item.path}:${item.line}:${item.column}`
}

function withNode(
  state: WorkbenchCallHierarchyState,
  node: WorkbenchCallHierarchyNode
): WorkbenchCallHierarchyState {
  return { ...state, nodes: new Map(state.nodes).set(node.id, node) }
}

/** 新的一棵：根展开着，它的下一层正在问。 */
export function createWorkbenchCallHierarchy(
  item: WorkbenchLanguageServiceCallHierarchyItem,
  direction: WorkbenchLanguageServiceCallHierarchyDirection
): WorkbenchCallHierarchyState {
  const root: WorkbenchCallHierarchyNode = {
    id: RootId,
    parentId: null,
    item,
    sites: [],
    depth: 0,
    expanded: true,
    childIds: null,
    loading: true,
    error: null,
    recursive: false,
  }
  return { direction, rootId: RootId, nodes: new Map([[RootId, root]]) }
}

/** 这个节点往上（含它自己）都有哪些函数。 */
function ancestorIdentities(
  state: WorkbenchCallHierarchyState,
  node: WorkbenchCallHierarchyNode
): Set<string> {
  const identities = new Set<string>()
  for (
    let current: LooseOptional<WorkbenchCallHierarchyNode> = node;
    current;
    current = current.parentId ? state.nodes.get(current.parentId) : undefined
  )
    identities.add(itemIdentity(current.item))
  return identities
}

/** 一个节点的下一层问到了：挂上去。节点已经不在（换了方向、重新打开过）或不在等答复，原样返回。 */
export function setWorkbenchCallHierarchyChildren(
  state: WorkbenchCallHierarchyState,
  nodeId: string,
  calls: readonly WorkbenchLanguageServiceCallHierarchyCall[]
): WorkbenchCallHierarchyState {
  const node = state.nodes.get(nodeId)
  if (!node?.loading) return state

  const seen = ancestorIdentities(state, node)
  const nodes = new Map(state.nodes)
  const childIds = calls.map((call, index) => {
    const id = `${nodeId}/${index}`
    nodes.set(id, {
      id,
      parentId: nodeId,
      item: call.item,
      sites: call.sites,
      depth: node.depth + 1,
      expanded: false,
      childIds: null,
      loading: false,
      error: null,
      recursive: seen.has(itemIdentity(call.item)),
    })
    return id
  })
  nodes.set(nodeId, { ...node, childIds, loading: false, error: null })
  return { ...state, nodes }
}

/** 一个节点的下一层没问到：记下原因，收起来（再展开会重问）。 */
export function failWorkbenchCallHierarchyNode(
  state: WorkbenchCallHierarchyState,
  nodeId: string,
  message: string
): WorkbenchCallHierarchyState {
  const node = state.nodes.get(nodeId)
  if (!node?.loading) return state
  return withNode(state, { ...node, loading: false, expanded: false, error: message })
}

/**
 * 展开或收起一个节点。第一次展开时下一层还没问过：`load` 为 true，调用方去问语言服务，答复回来调
 * setWorkbenchCallHierarchyChildren。递归到头的节点、正在问的节点不动。
 */
export function toggleWorkbenchCallHierarchyNode(
  state: WorkbenchCallHierarchyState,
  nodeId: string
): { state: WorkbenchCallHierarchyState; load: boolean } {
  const node = state.nodes.get(nodeId)
  if (!node || node.recursive || node.loading) return { state, load: false }
  if (node.childIds === null)
    return { state: withNode(state, { ...node, expanded: true, loading: true, error: null }), load: true }
  return { state: withNode(state, { ...node, expanded: !node.expanded }), load: false }
}

/** 眼下看得见的节点，从上到下：展开着的节点后面跟着它的下一层。 */
export function listWorkbenchCallHierarchyRows(
  state: WorkbenchCallHierarchyState
): WorkbenchCallHierarchyNode[] {
  const rows: WorkbenchCallHierarchyNode[] = []
  const visit = (id: string): void => {
    const node = state.nodes.get(id)
    if (!node) return
    rows.push(node)
    if (node.expanded) for (const childId of node.childIds ?? []) visit(childId)
  }
  visit(state.rootId)
  return rows
}

/** 这个节点还能不能往下展开：问过了而下一层是空的、或者递归到头的，不能。 */
export function canExpandWorkbenchCallHierarchyNode(node: WorkbenchCallHierarchyNode): boolean {
  return !node.recursive && (node.childIds === null || node.childIds.length > 0)
}

/**
 * 点一个节点跳到哪：看「谁调用它」时是调用方里发起调用的那一处（第一处），看「它调用谁」时是被调用的那个
 * 函数自己；根就是它自己。
 */
export function resolveWorkbenchCallHierarchyTarget(
  state: WorkbenchCallHierarchyState,
  node: WorkbenchCallHierarchyNode
): Pick<WorkbenchLanguageServiceLocation, 'path' | 'line' | 'column'> {
  const site = state.direction === 'incoming' ? node.sites[0] : undefined
  return site
    ? { path: site.path, line: site.line, column: site.column }
    : { path: node.item.path, line: node.item.line, column: node.item.column }
}

/**
 * 在列表里按方向键之后落在哪一行（下标）：上下挪一行；右键在收起的节点上是展开（`expand`），在展开的节点上
 * 进到它的第一个下一层；左键在展开的节点上是收起（`collapse`），否则回到上一层。不动返回 null。
 */
export function moveInWorkbenchCallHierarchy(
  rows: readonly WorkbenchCallHierarchyNode[],
  index: number,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
): Nullable<{ index: number } | { toggle: string }> {
  const node = rows[index]
  if (!node) return rows.length > 0 ? { index: 0 } : null

  switch (key) {
    case 'ArrowUp':
      return index > 0 ? { index: index - 1 } : null
    case 'ArrowDown':
      return index < rows.length - 1 ? { index: index + 1 } : null
    case 'ArrowRight':
      if (!canExpandWorkbenchCallHierarchyNode(node) || node.loading) return null
      if (!node.expanded || node.childIds === null) return { toggle: node.id }
      return rows[index + 1]?.parentId === node.id ? { index: index + 1 } : null
    case 'ArrowLeft': {
      if (node.expanded && (node.childIds?.length ?? 0) > 0) return { toggle: node.id }
      const parentIndex = rows.findIndex((row) => row.id === node.parentId)
      return parentIndex >= 0 ? { index: parentIndex } : null
    }
  }
}
