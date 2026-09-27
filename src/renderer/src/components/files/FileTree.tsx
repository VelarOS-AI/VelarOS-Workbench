import {
  type MouseEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useWorkbenchDensity } from '@renderer/hooks/useWorkbenchPreferences'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  buildTreeNodes,
  canDropTreeEntries,
  createOpenState,
  type FileTreeNodeData,
  getDefaultCreateName,
  resolveTreeCreateDirectoryPath,
  TREE_INDENT,
  TREE_OVERSCAN_COUNT,
} from '@renderer/models/files/fileTree.model'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import { getWorkbenchFileTreeRowHeight } from '@renderer/models/settings/workbenchPreferences'
import { ROOT_PATH } from '@renderer/models/shared/workbenchUtils'
import type { NodeApi, NodeRendererProps, TreeApi } from 'react-arborist'
import { Tree } from 'react-arborist'

import { isBlank, isEmpty } from '@velaros-ai/core'

import type { WorkbenchDirectoryEntry } from '@shared/contracts'

import { useFileTreeActions } from '../../hooks/useFileTreeActions'
import styles from '../../styles/workbenchPageStyles'

import {
  FileTreeRow,
  FileTreeRowRuntimeContext,
} from './FileTreeRow'

export type { FileTreeNodeData }

export type FileTreeApi = TreeApi<FileTreeNodeData>

interface FileTreeProps {
  entries: WorkbenchDirectoryEntry[]
  selectedPath: Nullable<string>
  /** 定位请求的计数：变了就把选中项滚进视野，哪怕选中项没变（用户滚走了、又定位到同一个文件）。 */
  revealRevision: number
  expandedPaths: Set<string>
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
  gitDecorations: WorkbenchGitDecorationMap
  searchTerm?: string
  isMutatingTree: boolean
  onTreeApiChange?: (api: Nullable<FileTreeApi>) => void
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

function renderFileTreeNode(props: NodeRendererProps<FileTreeNodeData>): ReactElement {
  return <FileTreeRow {...props} />
}

function matchFileTreeSearch(node: NodeApi<FileTreeNodeData>, normalizedTerm: string): boolean {
  if (isBlank(normalizedTerm)) return true

  return (
    node.data.name.toLowerCase().includes(normalizedTerm) ||
    node.data.entry.path.toLowerCase().includes(normalizedTerm)
  )
}

export function FileTree({
  entries,
  selectedPath,
  revealRevision,
  expandedPaths,
  childrenByPath,
  gitDecorations,
  searchTerm = '',
  isMutatingTree,
  onTreeApiChange,
  onSetDirectoryOpen,
  onSelectEntryPath,
  onSelectFile,
  onContextMenuEntry,
  onRenameEntry,
  onDeleteEntries,
  onMoveEntries,
}: FileTreeProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const density = useWorkbenchDensity()
  const rowHeight = getWorkbenchFileTreeRowHeight(density)
  const treeRef = useRef<FileTreeApi>(null)
  const syncingOpenStateRef = useRef(false)
  const openStateChangedInTreeRef = useRef(false)

  const {
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
  } = useFileTreeActions({
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
  })

  const treeData = useMemo(
    () => buildTreeNodes(entries, childrenByPath, expandedPaths),
    [childrenByPath, entries, expandedPaths]
  )
  const [initialOpenState] = useState(() => createOpenState(expandedPaths))
  const normalizedSearchTerm = useMemo(() => searchTerm.trim().toLowerCase(), [searchTerm])
  // @arch-guard:suspend velaros/code-style/prefer-meaningful-use-memo 理由：Context value 的引用稳定性用于阻止文件选择时刷新全部可见树行。
  const rowRuntime = useMemo(
    () => ({
      collapseDirectoryLabel: t('workbench.treeCollapseFolder'),
      expandDirectoryLabel: t('workbench.treeExpandFolder'),
      gitDecorations,
      isMutatingTree,
      onContextMenuEntry: handleTreeContextMenuEntry,
    }),
    [gitDecorations, handleTreeContextMenuEntry, isMutatingTree, t]
  )
  const disableTreeEntryMutation = useCallback(
    (data: FileTreeNodeData) => isMutatingTree || data.entry.path === ROOT_PATH,
    [isMutatingTree]
  )
  // 拖到顶层条目之间或列表空白处时，Arborist 给的父节点是它自己的内部根节点（没有条目数据），
  // 那就是工程根目录。
  const disableTreeDrop = useCallback(
    ({
      parentNode,
      dragNodes,
    }: {
      parentNode: NodeApi<FileTreeNodeData>
      dragNodes: Array<NodeApi<FileTreeNodeData>>
    }): boolean => isMutatingTree || !canDropTreeEntries(parentNode, dragNodes),
    [isMutatingTree]
  )
  const handleTreeToggleFromTree = useCallback(
    (id: string): void => {
      if (!syncingOpenStateRef.current) openStateChangedInTreeRef.current = true
      handleTreeToggle(id)
    },
    [handleTreeToggle]
  )

  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    if (openStateChangedInTreeRef.current) {
      openStateChangedInTreeRef.current = false
      return
    }

    syncingOpenStateRef.current = true
    try {
      tree.visibleNodes.forEach((node) => {
        if (node.data.entry.type === 'directory' && node.isOpen && !expandedPaths.has(node.id)) {
          tree.close(node.id)
        }
      })
      expandedPaths.forEach((path) => {
        const node = tree.get(path)
        if (node && node.data.entry.type === 'directory' && !node.isOpen) tree.open(path)
      })
    } finally {
      syncingOpenStateRef.current = false
    }
  }, [expandedPaths, treeData, treeSize.measured])

  // 树要等测到真实尺寸才挂载（见 FileTreeSize.measured）；依赖带上 measured，挂上后补一次选中同步与滚动。
  // 定位的祖先目录还在加载时节点还不在树里：等 treeData 带上它再选中、滚动。
  const scrolledRevealRevisionRef = useRef(revealRevision)
  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return

    if (selectedPath) {
      if (!tree.get(selectedPath)) return
      // 选中项已经在当前选择里（含 ⌘/Shift 多选：selectedPath 是最后点的那一项）就不动它。
      // 以前要求选择恰好只有这一项，多选刚形成就被这里收回成单选，多选删除、多选「添加到聊天」都用不上。
      const selectionAlreadyMatches = tree.selectedIds.has(selectedPath)
      // select 自带滚动；选中项没变时，只有新的定位请求才滚。
      if (!selectionAlreadyMatches) tree.select(selectedPath, { focus: false })
      else if (scrolledRevealRevisionRef.current !== revealRevision) void tree.scrollTo(selectedPath)
      scrolledRevealRevisionRef.current = revealRevision
      return
    }

    if (tree.selectedIds.size > 0) tree.deselectAll()
  }, [revealRevision, selectedPath, treeData, treeSize.measured])

  return (
    <div ref={setTreeShell} className={styles.arboristTreeShell}>
      <FileTreeRowRuntimeContext.Provider value={rowRuntime}>
        {treeSize.measured && (
          <Tree<FileTreeNodeData>
            ref={setTreeRef}
            data={treeData}
            idAccessor="id"
            childrenAccessor="children"
            rowHeight={rowHeight}
            overscanCount={TREE_OVERSCAN_COUNT}
            indent={TREE_INDENT}
            width={treeSize.width}
            height={treeSize.height}
            initialOpenState={initialOpenState}
            disableEdit={disableTreeEntryMutation}
            disableDrag={disableTreeEntryMutation}
            disableDrop={disableTreeDrop}
            searchTerm={normalizedSearchTerm}
            searchMatch={matchFileTreeSearch}
            onActivate={handleTreeActivate}
            onSelect={handleTreeSelect}
            onToggle={handleTreeToggleFromTree}
            onRename={handleTreeRename}
            onDelete={handleTreeDelete}
            onMove={handleTreeMove}
            className={styles.arboristTreeList}
            rowClassName={styles.arboristTreeVirtualRow}
          >
            {renderFileTreeNode}
          </Tree>
        )}
      </FileTreeRowRuntimeContext.Provider>
    </div>
  )
}

/** 新建之后等新行出现在树里（父目录刚展开、刚读完）的最多帧数。 */
const CREATED_TREE_ENTRY_EDIT_MAX_FRAMES = 30

interface CreateTreeEntryOptions {
  treeRef: { readonly current: Nullable<FileTreeApi> }
  type: WorkbenchDirectoryEntry['type']
  /** 右键的那一项：目录建在它里面，文件建在它旁边，工程根（`.`）建在根目录。 */
  anchorEntry: WorkbenchDirectoryEntry
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
  onCreateEntry: (
    type: WorkbenchDirectoryEntry['type'],
    parentEntry: Nullable<WorkbenchDirectoryEntry>,
    name: string
  ) => Promise<Nullable<WorkbenchDirectoryEntry>>
}

/**
 * 新建条目只走显式的命令（右键菜单）：`<Tree>` 不带 `onCreate`，Arborist 的默认快捷键（`a` 建文件、
 * `Shift+A` 建目录）因此什么也不做，打字跳转与方向键导航照旧。建好之后等新行出现，进入行内改名。
 */
export async function createTreeEntry({
  treeRef,
  type,
  anchorEntry,
  childrenByPath,
  onCreateEntry,
}: CreateTreeEntryOptions): Promise<void> {
  const parentPath = resolveTreeCreateDirectoryPath(anchorEntry)
  const createdEntry = await onCreateEntry(
    type,
    anchorEntry,
    getDefaultCreateName(type, parentPath, childrenByPath)
  )
  if (createdEntry) editTreeEntryWhenVisible(treeRef, createdEntry.path)
}

/**
 * 新行要等父目录重新读完才进树：逐帧等它出现，出现后聚焦并进入改名，改完选中并打开
 * （与 Arborist 自带的新建流程一致）。
 */
function editTreeEntryWhenVisible(
  treeRef: { readonly current: Nullable<FileTreeApi> },
  path: string,
  remainingFrames = CREATED_TREE_ENTRY_EDIT_MAX_FRAMES
): void {
  const tree = treeRef.current
  if (tree?.get(path)) {
    tree.focus(path)
    void tree.edit(path).then(() => {
      tree.select(path)
      tree.activate(path)
    })
    return
  }

  if (remainingFrames <= 0) return
  requestAnimationFrame(() => editTreeEntryWhenVisible(treeRef, path, remainingFrames - 1))
}

export function renameSelectedTreeEntry(tree: Nullable<FileTreeApi>): void {
  const node = tree?.mostRecentNode
  if (!node || node.data.entry.path === ROOT_PATH) return

  void tree?.edit(node)
}

/** 右键点在一组多选（两项及以上）里面：这时菜单作用于整组，而不是把选择收成右键的那一项。 */
export function isTreeEntryInMultiSelection(tree: Nullable<FileTreeApi>, path: string): boolean {
  return !!tree && tree.selectedIds.size > 1 && tree.selectedIds.has(path)
}

/** 右键「添加到聊天」要挂的文件：点在多选里取整组里的文件，否则只取右键的那个；目录不挂。 */
export function resolveTreeChatFilePaths(
  tree: Nullable<FileTreeApi>,
  entry: WorkbenchDirectoryEntry
): string[] {
  if (tree && isTreeEntryInMultiSelection(tree, entry.path))
    return tree.selectedNodes
      .filter((node) => node.data.entry.type === 'file')
      .map((node) => node.data.entry.path)

  return entry.type === 'file' ? [entry.path] : []
}

export function deleteSelectedTreeEntries(tree: Nullable<FileTreeApi>): void {
  if (!tree) return

  const selectedIds = [...tree.selectedIds].filter((id) => id !== ROOT_PATH)
  if (isEmpty(selectedIds)) return

  void tree.delete(selectedIds)
}

export function openAllTreeEntries(
  tree: Nullable<FileTreeApi>,
  onSetDirectoryOpen: (path: string, open: boolean) => void
): void {
  if (!tree) return

  tree.openAll()
  tree.visibleNodes
    .filter((node) => node.data.entry.type === 'directory')
    .forEach((node) => onSetDirectoryOpen(node.id, true))
}

export function closeAllTreeEntries(
  tree: Nullable<FileTreeApi>,
  expandedPaths: Set<string>,
  onSetDirectoryOpen: (path: string, open: boolean) => void
): void {
  tree?.closeAll()
  void tree?.open(ROOT_PATH)
  expandedPaths.forEach((path) => {
    if (path !== ROOT_PATH) {
      onSetDirectoryOpen(path, false)
    }
  })
}
