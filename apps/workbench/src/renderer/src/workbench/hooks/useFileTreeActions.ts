import { type MouseEvent,type MutableRefObject, useCallback, useEffect, useState,  } from 'react'
import type { NodeApi, TreeApi } from 'react-arborist'

import { toNullable } from '@velaros-ai/core'
import type { WorkbenchDirectoryEntry } from '@velaros-ai/workbench/contracts'
import {
  DEFAULT_TREE_WIDTH,
  type FileTreeNodeData,
  getDefaultCreateName,
} from '@velaros-ai/workbench/models/files/fileTree.model'
import { isWorkbenchTreeRoot,ROOT_PATH } from '@velaros-ai/workbench/models/shared/workbenchUtils'

import { useLatest, useMemoizedFn } from '../support/genericHooks'

function useElementSize(): [
  (node: Nullable<HTMLDivElement>) => void,
  { width: number; height: number },
] {
  const [node, setNode] = useState<Nullable<HTMLDivElement>>(null)
  const [size, setSize] = useState({ width: DEFAULT_TREE_WIDTH, height: 1 })

  useEffect(() => {
    if (!node) return

    const updateSize = (): void => {
      const nextRect = node.getBoundingClientRect()
      const width = Math.max(1, nextRect.width)
      const height = Math.max(1, nextRect.height)
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height }
      )
    }
    updateSize()

    const resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(node)
    return () => resizeObserver.disconnect()
  }, [node])

  return [setNode, size]
}

export interface UseFileTreeActionsParams {
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
  treeRef: MutableRefObject<Nullable<TreeApi<FileTreeNodeData>>>
  selectionOriginRef: MutableRefObject<Nullable<'tree'>>
  syncingOpenStateRef: MutableRefObject<boolean>
  onTreeApiChange?: (api: Nullable<TreeApi<FileTreeNodeData>>) => void
  onSetDirectoryOpen: (path: string, open: boolean) => void
  onSelectEntryPath: (path: Nullable<string>) => void
  onSelectFile: (path: string) => void
  onContextMenuEntry: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
  onCreateEntry: (
    type: WorkbenchDirectoryEntry['type'],
    parentEntry: Nullable<WorkbenchDirectoryEntry>,
    name: string
  ) => Promise<Nullable<WorkbenchDirectoryEntry>>
  onRenameEntry: (
    entry: WorkbenchDirectoryEntry,
    name: string
  ) => Promise<Nullable<WorkbenchDirectoryEntry>>
  onDeleteEntries: (entries: WorkbenchDirectoryEntry[]) => Promise<void>
  onMoveEntries: (
    entries: WorkbenchDirectoryEntry[],
    parentEntry: Nullable<WorkbenchDirectoryEntry>,
    index: number
  ) => Promise<void>
}

export function useFileTreeActions({
  childrenByPath,
  treeRef,
  selectionOriginRef,
  syncingOpenStateRef,
  onTreeApiChange,
  onSetDirectoryOpen,
  onSelectEntryPath,
  onSelectFile,
  onContextMenuEntry,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntries,
  onMoveEntries,
}: UseFileTreeActionsParams): {
  setTreeShell: (node: Nullable<HTMLDivElement>) => void
  treeSize: { width: number; height: number }
  setTreeRef: (api: LooseOptional<TreeApi<FileTreeNodeData>>) => void
  handleTreeContextMenuEntry: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
  handleTreeActivate: (node: NodeApi<FileTreeNodeData>) => void
  handleTreeSelect: (nodes: Array<NodeApi<FileTreeNodeData>>) => void
  handleTreeToggle: (id: string) => void
  handleTreeCreate: (args: {
    parentNode?: LooseOptional<NodeApi<FileTreeNodeData>>
    type: 'internal' | 'leaf'
  }) => Promise<Nullable<{ id: string }>>
  handleTreeRename: (args: {
    node: NodeApi<FileTreeNodeData>
    name: string
  }) => Promise<void>
  handleTreeDelete: (args: { nodes: Array<NodeApi<FileTreeNodeData>> }) => Promise<void>
  handleTreeMove: (args: {
    dragNodes: Array<NodeApi<FileTreeNodeData>>
    parentNode?: LooseOptional<NodeApi<FileTreeNodeData>>
    index: number
  }) => Promise<void>
} {
  const [setTreeShell, treeSize] = useElementSize()

  const onTreeApiChangeLatest = useLatest(onTreeApiChange)
  const onSetDirectoryOpenLatest = useLatest(onSetDirectoryOpen)
  const onSelectEntryPathLatest = useLatest(onSelectEntryPath)
  const onSelectFileLatest = useLatest(onSelectFile)
  const onContextMenuEntryLatest = useLatest(onContextMenuEntry)
  const onCreateEntryLatest = useLatest(onCreateEntry)
  const onRenameEntryLatest = useLatest(onRenameEntry)
  const onDeleteEntriesLatest = useLatest(onDeleteEntries)
  const onMoveEntriesLatest = useLatest(onMoveEntries)
  const childrenByPathLatest = useLatest(childrenByPath)

  const setTreeRef = useCallback((api: LooseOptional<TreeApi<FileTreeNodeData>>): void => {
    treeRef.current = (toNullable(api))
    onTreeApiChangeLatest.current?.((toNullable(api)))
  }, [])

  const handleTreeContextMenuEntry = useMemoizedFn(
    (entry: WorkbenchDirectoryEntry, event: MouseEvent): void => {
      onContextMenuEntryLatest.current(entry, event)
    }
  )

  const handleTreeActivate = useMemoizedFn((node: NodeApi<FileTreeNodeData>): void => {
    if (node.data.entry.type === 'directory') {
      if (isWorkbenchTreeRoot(node.data.entry)) {
        onSelectEntryPathLatest.current(ROOT_PATH)
        return
      }
      node.toggle()
      return
    }

    onSelectFileLatest.current(node.data.entry.path)
  })

  const handleTreeSelect = useMemoizedFn((nodes: Array<NodeApi<FileTreeNodeData>>): void => {
    selectionOriginRef.current = 'tree'
    onSelectEntryPathLatest.current(toNullable(nodes.at(-1)?.data.entry.path))
  })

  const handleTreeToggle = useMemoizedFn((id: string): void => {
    if (syncingOpenStateRef.current) return

    const tree = treeRef.current
    const node = tree?.get(id)
    if (!node || node.data.entry.type !== 'directory') return

    if (id === ROOT_PATH && !node.isOpen) {
      syncingOpenStateRef.current = true
      try {
        tree?.open(ROOT_PATH)
      } finally {
        syncingOpenStateRef.current = false
      }
      return
    }

    onSetDirectoryOpenLatest.current(id, node.isOpen)
  })

  const handleTreeCreate = useMemoizedFn(
    async ({
      parentNode,
      type,
    }: {
      parentNode?: LooseOptional<NodeApi<FileTreeNodeData>>
      type: 'internal' | 'leaf'
    }): Promise<Nullable<{ id: string }>> => {
      const parentEntry = (toNullable(parentNode?.data.entry))
      const entryType = type === 'internal' ? 'directory' : 'file'
      const createdEntry = await onCreateEntryLatest.current(
        entryType,
        parentEntry,
        getDefaultCreateName(entryType, parentEntry, childrenByPathLatest.current)
      )

      return createdEntry ? { id: createdEntry.path } : null
    }
  )

  const handleTreeRename = useMemoizedFn(
    async ({
      node,
      name,
    }: {
      node: NodeApi<FileTreeNodeData>
      name: string
    }): Promise<void> => {
      await onRenameEntryLatest.current(node.data.entry, name)
    }
  )

  const handleTreeDelete = useMemoizedFn(
    async ({ nodes }: { nodes: Array<NodeApi<FileTreeNodeData>> }): Promise<void> => {
      await onDeleteEntriesLatest.current(nodes.map((item) => item.data.entry))
    }
  )

  const handleTreeMove = useMemoizedFn(
    async ({
      dragNodes,
      parentNode,
      index,
    }: {
      dragNodes: Array<NodeApi<FileTreeNodeData>>
      parentNode?: LooseOptional<NodeApi<FileTreeNodeData>>
      index: number
    }): Promise<void> => {
      await onMoveEntriesLatest.current(
        dragNodes.map((dragNode) => dragNode.data.entry),
        (toNullable(parentNode?.data.entry)),
        index
      )
    }
  )

  return {
    setTreeShell,
    treeSize,
    setTreeRef,
    handleTreeContextMenuEntry,
    handleTreeActivate,
    handleTreeSelect,
    handleTreeToggle,
    handleTreeCreate,
    handleTreeRename,
    handleTreeDelete,
    handleTreeMove,
  }
}
