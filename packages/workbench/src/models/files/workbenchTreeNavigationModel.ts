import type { WorkbenchDirectoryEntry } from '@velaros-ai/core/types'

export interface WorkbenchVisibleTreeNode {
  depth: number
  entry: WorkbenchDirectoryEntry
}

export type WorkbenchTreeKeyboardAction =
  | { kind: 'open-file'; path: string }
  | { kind: 'select'; path: string }
  | { kind: 'toggle-directory'; path: string }

interface BuildWorkbenchVisibleTreeNodesInput {
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
  expandedPaths: Set<string>
  rootEntries: WorkbenchDirectoryEntry[]
}

interface WorkbenchTreeKeyboardActionInput {
  expandedPaths: Set<string>
  key: string
  selectedPath: Nullable<string>
  visibleNodes: WorkbenchVisibleTreeNode[]
}

export function buildWorkbenchVisibleTreeNodes({
  childrenByPath,
  expandedPaths,
  rootEntries,
}: BuildWorkbenchVisibleTreeNodesInput): WorkbenchVisibleTreeNode[] {
  const nodes: WorkbenchVisibleTreeNode[] = []

  function visit(entries: WorkbenchDirectoryEntry[], depth: number): void {
    for (const entry of entries) {
      nodes.push({ depth, entry })

      if (entry.type === 'directory' && expandedPaths.has(entry.path)) {
        visit(childrenByPath.get(entry.path) ?? [], depth + 1)
      }
    }
  }

  visit(rootEntries, 0)
  return nodes
}

function getSelectedNodeIndex(
  nodes: WorkbenchVisibleTreeNode[],
  selectedPath: Nullable<string>
): number {
  if (!selectedPath) return -1

  return nodes.findIndex((node) => node.entry.path === selectedPath)
}

function selectNodeAtIndex(
  nodes: WorkbenchVisibleTreeNode[],
  index: number
): Nullable<WorkbenchTreeKeyboardAction> {
  const node = nodes[index]
  return node ? { kind: 'select', path: node.entry.path } : null
}

function selectParentNode(
  nodes: WorkbenchVisibleTreeNode[],
  selectedIndex: number
): Nullable<WorkbenchTreeKeyboardAction> {
  const selectedNode = nodes[selectedIndex]
  if (!selectedNode || selectedNode.depth === 0) return null

  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    if (nodes[index].depth === selectedNode.depth - 1) return { kind: 'select', path: nodes[index].entry.path }
  }

  return null
}

export function getWorkbenchTreeKeyboardAction({
  expandedPaths,
  key,
  selectedPath,
  visibleNodes,
}: WorkbenchTreeKeyboardActionInput): Nullable<WorkbenchTreeKeyboardAction> {
  if (!visibleNodes.length) return null

  const selectedIndex = getSelectedNodeIndex(visibleNodes, selectedPath)
  if (selectedIndex === -1) {
    if (key === 'ArrowUp' || key === 'End') return selectNodeAtIndex(visibleNodes, visibleNodes.length - 1)

    if (key === 'ArrowDown' || key === 'Home') return selectNodeAtIndex(visibleNodes, 0)

    return null
  }

  const effectiveIndex = selectedIndex
  const selectedNode = visibleNodes[effectiveIndex]

  switch (key) {
    case 'ArrowDown': {
      return selectNodeAtIndex(visibleNodes, Math.min(effectiveIndex + 1, visibleNodes.length - 1))
    }
    case 'ArrowUp': {
      return selectNodeAtIndex(visibleNodes, Math.max(effectiveIndex - 1, 0))
    }
    case 'Home': {
      return selectNodeAtIndex(visibleNodes, 0)
    }
    case 'End': {
      return selectNodeAtIndex(visibleNodes, visibleNodes.length - 1)
    }
  }

  if (!selectedNode) return null

  if (key === 'Enter') {
    if (selectedNode.entry.type === 'file') return { kind: 'open-file', path: selectedNode.entry.path }

    return { kind: 'toggle-directory', path: selectedNode.entry.path }
  }

  if (key === 'ArrowRight') {
    if (selectedNode.entry.type !== 'directory') return null

    if (!expandedPaths.has(selectedNode.entry.path)) return { kind: 'toggle-directory', path: selectedNode.entry.path }

    const nextNode = visibleNodes[effectiveIndex + 1]
    return nextNode && nextNode.depth > selectedNode.depth
      ? { kind: 'select', path: nextNode.entry.path }
      : null
  }

  if (key === 'ArrowLeft') {
    if (selectedNode.entry.type === 'directory' && expandedPaths.has(selectedNode.entry.path)) return { kind: 'toggle-directory', path: selectedNode.entry.path }

    return selectParentNode(visibleNodes, effectiveIndex)
  }

  return null
}
