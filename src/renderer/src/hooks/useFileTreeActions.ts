import { type MouseEvent, type MutableRefObject, useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_TREE_WIDTH,
  type FileTreeNodeData,
  isUnresolvedTreeSymlink,
} from '@renderer/models/files/fileTree.model'
import { isWorkbenchTreeRoot, ROOT_PATH } from '@renderer/models/shared/workbenchUtils'
import type { NodeApi, TreeApi } from 'react-arborist'

import { toNullable } from '@velaros-ai/velaros/core'

import { type WorkbenchDirectoryEntry } from '@shared/contracts/workbench'

import { useLatest, useMemoizedFn } from '../support/genericHooks'

export interface FileTreeSize {
  width: number
  height: number
  /**
   * 是否已拿到真实尺寸。挂载首帧只有占位值（高 1px），树必须等它为 true 才渲染：
   * 在 1px 视口里执行「滚到选中项」会算出越界的滚动偏移，react-window 不做夹取，
   * 真实高度到位后 DOM scrollTop 被浏览器夹回 0，列表内部却仍按旧偏移只渲染后半截——
   * 从「提交」切回文件面板时顶部一片空白就是这么来的。
   */
  measured: boolean
}

function useElementSize(): [(node: Nullable<HTMLDivElement>) => void, FileTreeSize] {
  const [node, setNode] = useState<Nullable<HTMLDivElement>>(null)
  const [size, setSize] = useState<FileTreeSize>({
    width: DEFAULT_TREE_WIDTH,
    height: 1,
    measured: false,
  })

  useEffect(() => {
    if (!node) return

    const updateSize = (): void => {
      const nextRect = node.getBoundingClientRect()
      const width = Math.max(1, nextRect.width)
      const height = Math.max(1, nextRect.height)
      setSize((current) =>
        current.measured && current.width === width && current.height === height
          ? current
          : { width, height, measured: true }
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
  treeRef: MutableRefObject<Nullable<TreeApi<FileTreeNodeData>>>
  syncingOpenStateRef: MutableRefObject<boolean>
  onTreeApiChange?: (api: Nullable<TreeApi<FileTreeNodeData>>) => void
  onSetDirectoryOpen: (path: string, open: boolean) => void
  onSelectEntryPath: (path: Nullable<string>) => void
  onSelectFile: (path: string) => void
  onContextMenuEntry: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
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
  treeRef,
  syncingOpenStateRef,
  onTreeApiChange,
  onSetDirectoryOpen,
  onSelectEntryPath,
  onSelectFile,
  onContextMenuEntry,
  onRenameEntry,
  onDeleteEntries,
  onMoveEntries,
}: UseFileTreeActionsParams): {
  setTreeShell: (node: Nullable<HTMLDivElement>) => void
  treeSize: FileTreeSize
  setTreeRef: (api: LooseOptional<TreeApi<FileTreeNodeData>>) => void
  handleTreeContextMenuEntry: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
  handleTreeActivate: (node: NodeApi<FileTreeNodeData>) => void
  handleTreeSelect: (nodes: Array<NodeApi<FileTreeNodeData>>) => void
  handleTreeToggle: (id: string) => void
  handleTreeRename: (args: { node: NodeApi<FileTreeNodeData>; name: string }) => Promise<void>
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
  const onRenameEntryLatest = useLatest(onRenameEntry)
  const onDeleteEntriesLatest = useLatest(onDeleteEntries)
  const onMoveEntriesLatest = useLatest(onMoveEntries)

  const setTreeRef = useCallback((api: LooseOptional<TreeApi<FileTreeNodeData>>): void => {
    treeRef.current = toNullable(api)
    onTreeApiChangeLatest.current?.(toNullable(api))
  }, [])

  const handleTreeContextMenuEntry = useMemoizedFn(
    (entry: WorkbenchDirectoryEntry, event: MouseEvent): void => {
      onContextMenuEntryLatest.current(entry, event)
    }
  )

  const handleTreeActivate = useMemoizedFn((node: NodeApi<FileTreeNodeData>): void => {
    // 链接的目标在工程外或已不存在：只选中链接本身（还能改名、移动、删除），不去打开。
    if (isUnresolvedTreeSymlink(node.data.entry)) {
      onSelectEntryPathLatest.current(node.data.entry.path)
      return
    }

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

  const handleTreeRename = useMemoizedFn(
    async ({ node, name }: { node: NodeApi<FileTreeNodeData>; name: string }): Promise<void> => {
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
        toNullable(parentNode?.data.entry),
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
    handleTreeRename,
    handleTreeDelete,
    handleTreeMove,
  }
}
