import { useRef, useState } from 'react'

import { isEmpty, toNullable } from '@velaros/core'
import { AppError } from '@velaros/core/error'
import { Result } from '@velaros/core/result'
import type {
  WorkbenchDeleteEntryResult, WorkbenchDirectoryEntry, WorkbenchMoveEntryResult, WorkbenchRestoreDeletedEntryResult, } from '@velaros/core/types'
import { workbenchHost } from '@velaros/workbench/host'
import {
  removeWorkbenchCommentsUnderPath,
  renameWorkbenchCommentsPath,
} from '@velaros/workbench/models/comments/workbenchCommentStore'
import {
  resolveTreeActionBasePath,
  resolveTreeActionBasePathForEntry,
  selectMovableTreeEntries,
} from '@velaros/workbench/models/files/workbenchTreeMutation'
import type { WorkbenchProject } from '@velaros/workbench/models/project/workbenchProjects'
import { getParentPath, ROOT_PATH } from '@velaros/workbench/models/shared/workbenchUtils'
import type { PendingTreeAction } from '@velaros/workbench/types/workbenchTypes'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest } from '../support/genericHooks'

interface UseWorkbenchMutationControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  selectedEntry: Nullable<WorkbenchDirectoryEntry>
  selectedEntryPath: Nullable<string>
  ensureNoUnsavedFilesInPath: (path: string) => boolean
  selectFile: (path: string) => Promise<void>
  moveOpenEntryPath: (previousPath: string, nextPath: string, modifiedAt?: LooseOptional<number>) => void
  closeOpenEntryPath: (path: string) => void
  setSelectedEntryPath: (path: Nullable<string>) => void
  refreshMutationParent: (parentPath: string) => Promise<void>
  pruneTreeCache: (path: string) => void
  resetSearch: () => void
  onTreeChanged: () => void
}

interface WorkbenchDeleteUndoBatch {
  projectId: string
  projectRoot: string
  results: WorkbenchDeleteEntryResult[]
}

export function useWorkbenchMutationController({
  activeProject,
  selectedEntry,
  selectedEntryPath,
  ensureNoUnsavedFilesInPath,
  selectFile,
  moveOpenEntryPath,
  closeOpenEntryPath,
  setSelectedEntryPath,
  refreshMutationParent,
  pruneTreeCache,
  resetSearch,
  onTreeChanged,
}: UseWorkbenchMutationControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const activeProjectRef = useLatest(activeProject)
  const closeOpenEntryPathLatest = useLatest(closeOpenEntryPath)
  const moveOpenEntryPathLatest = useLatest(moveOpenEntryPath)
  const onTreeChangedLatest = useLatest(onTreeChanged)
  const pruneTreeCacheLatest = useLatest(pruneTreeCache)
  const refreshMutationParentLatest = useLatest(refreshMutationParent)
  const resetSearchLatest = useLatest(resetSearch)
  const selectFileLatest = useLatest(selectFile)
  const setSelectedEntryPathLatest = useLatest(setSelectedEntryPath)
  const deleteUndoStackRef = useRef<WorkbenchDeleteUndoBatch[]>([])

  const [pendingTreeAction, setPendingTreeAction] = useState<Nullable<PendingTreeAction>>(null)
  const [treeActionName, setTreeActionName] = useState('')
  const [isMutatingTree, setIsMutatingTree] = useState(false)

  function resetTreeAction(): void {
    setPendingTreeAction(null)
    setTreeActionName('')
  }

  /** 统一的树变更失败提示：被多处 IPC catch 复用。 */
  function notifyTreeMutationError(error: unknown): void {
    messageLatest.current.error({
      title: tLatest.current('workbench.treeMutationFailed'),
      description: AppError.from(error).message,
    })
  }

  function getTreeActionBasePathForEntry(entry: Nullable<WorkbenchDirectoryEntry>): string {
    return resolveTreeActionBasePathForEntry(
      entry,
      resolveTreeActionBasePath(selectedEntry, selectedEntryPath)
    )
  }

  function beginCreateEntry(
    type: WorkbenchDirectoryEntry['type'],
    baseEntry: Nullable<WorkbenchDirectoryEntry> = null
  ): void {
    setPendingTreeAction({
      kind: type === 'file' ? 'create-file' : 'create-directory',
      basePath: getTreeActionBasePathForEntry(baseEntry),
    })
    setTreeActionName(type === 'file' ? 'untitled.txt' : 'new-folder')
  }

  function beginRenameEntry(entry: Nullable<WorkbenchDirectoryEntry> = selectedEntry): void {
    if (!entry) return

    setPendingTreeAction({
      kind: 'rename',
      basePath: getParentPath(entry.path),
      entryPath: entry.path,
      entryType: entry.type,
    })
    setTreeActionName(entry.name)
  }

  function rememberDeletedEntries(
    project: WorkbenchProject,
    results: WorkbenchDeleteEntryResult[]
  ): void {
    if (isEmpty(results)) return

    deleteUndoStackRef.current = [
      ...deleteUndoStackRef.current,
      {
        projectId: project.id,
        projectRoot: project.rootPath,
        results,
      },
    ].slice(-20)
  }

  function takeLatestDeleteUndoBatch(project: WorkbenchProject): Nullable<WorkbenchDeleteUndoBatch> {
    const stack = deleteUndoStackRef.current
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const batch = stack[index]
      if (!batch || batch.projectId !== project.id) continue

      deleteUndoStackRef.current = [
        ...stack.slice(0, index),
        ...stack.slice(index + 1),
      ]
      return batch
    }

    return null
  }

  async function createTreeEntry(
    type: WorkbenchDirectoryEntry['type'],
    parentEntry: Nullable<WorkbenchDirectoryEntry>,
    name: string
  ): Promise<Nullable<WorkbenchDirectoryEntry>> {
    if (!activeProject || isMutatingTree) return null

    const owningProject = activeProject
    const owningProjectId = owningProject.id

    const normalizedName = name.trim()
    if (!normalizedName) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.entryNameRequired'),
      })
      return null
    }

    try {
      setIsMutatingTree(true)
      const result = Result.unwrap(
        await workbenchHost.kernel.project.createWorkbenchEntry({
          projectRoot: owningProject.rootPath,
          parentPath: getTreeActionBasePathForEntry(parentEntry),
          name: normalizedName,
          type,
        })
      )

      if (activeProjectRef.current?.id !== owningProjectId) return null

      onTreeChangedLatest.current()
      await refreshMutationParentLatest.current(result.parentPath)
      setSelectedEntryPathLatest.current(result.entry.path)
      resetTreeAction()
      resetSearchLatest.current()
      messageLatest.current.success({
        title: tLatest.current('workbench.createSucceeded'),
      })
      return result.entry
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return null

      notifyTreeMutationError(error)
      return null
    } finally {
      setIsMutatingTree(false)
    }
  }

  async function renameTreeEntry(
    entry: WorkbenchDirectoryEntry,
    name: string
  ): Promise<Nullable<WorkbenchDirectoryEntry>> {
    if (!activeProject || isMutatingTree || entry.path === ROOT_PATH) return null

    const owningProject = activeProject
    const owningProjectId = owningProject.id

    const normalizedName = name.trim()
    if (!normalizedName) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.entryNameRequired'),
      })
      return null
    }

    if (normalizedName === entry.name) return entry

    if (!ensureNoUnsavedFilesInPath(entry.path)) return null

    try {
      setIsMutatingTree(true)
      const result = Result.unwrap(
        await workbenchHost.kernel.project.renameWorkbenchEntry({
          projectRoot: owningProject.rootPath,
          path: entry.path,
          newName: normalizedName,
        })
      )

      if (activeProjectRef.current?.id !== owningProjectId) return null

      onTreeChangedLatest.current()
      await refreshMutationParentLatest.current(result.parentPath)
      setSelectedEntryPathLatest.current(result.entry.path)
      resetTreeAction()
      resetSearchLatest.current()

      if (entry.type === 'directory') {
        pruneTreeCacheLatest.current(entry.path)
      }

      moveOpenEntryPathLatest.current(entry.path, result.entry.path, result.entry.modifiedAt)
      renameWorkbenchCommentsPath(owningProject.rootPath, entry.path, result.entry.path)
      messageLatest.current.success({
        title: tLatest.current('workbench.renameSucceeded'),
      })
      return result.entry
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return null

      notifyTreeMutationError(error)
      return null
    } finally {
      setIsMutatingTree(false)
    }
  }

  async function moveTreeEntries(
    entries: WorkbenchDirectoryEntry[],
    parentEntry: Nullable<WorkbenchDirectoryEntry>
  ): Promise<void> {
    if (!activeProject || isMutatingTree) return

    const owningProject = activeProject
    const owningProjectId = owningProject.id

    const movableEntries = selectMovableTreeEntries(entries)
    if (isEmpty(movableEntries)) return

    for (const entry of movableEntries) {
      if (!ensureNoUnsavedFilesInPath(entry.path)) return
    }

    try {
      setIsMutatingTree(true)
      const movedResults: Array<{
        source: WorkbenchDirectoryEntry
        result: WorkbenchMoveEntryResult
      }> = []
      for (const entry of movableEntries) {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.moveWorkbenchEntry({
            projectRoot: owningProject.rootPath,
            path: entry.path,
            parentPath: parentEntry?.path ?? ROOT_PATH,
            name: entry.name,
          })
        )
        movedResults.push({ source: entry, result })
      }

      if (activeProjectRef.current?.id !== owningProjectId) return

      onTreeChangedLatest.current()
      const parentsToRefresh = new Set<string>()
      for (const { source, result } of movedResults) {
        parentsToRefresh.add(result.previousParentPath)
        parentsToRefresh.add(result.parentPath)
        if (source.type === 'directory') {
          pruneTreeCacheLatest.current(result.previousPath)
        }
        moveOpenEntryPathLatest.current(result.previousPath, result.entry.path, result.entry.modifiedAt)
        renameWorkbenchCommentsPath(owningProject.rootPath, result.previousPath, result.entry.path)
      }

      await Promise.all(
        [...parentsToRefresh].map((parentPath) => refreshMutationParentLatest.current(parentPath))
      )
      const lastMovedEntry = movedResults.at(-1)?.result.entry
      setSelectedEntryPathLatest.current((toNullable(lastMovedEntry?.path)))
      resetTreeAction()
      resetSearchLatest.current()
      messageLatest.current.success({
        title: tLatest.current('workbench.moveSucceeded'),
      })
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      notifyTreeMutationError(error)
    } finally {
      setIsMutatingTree(false)
    }
  }

  async function deleteTreeEntries(entries: WorkbenchDirectoryEntry[]): Promise<void> {
    if (!activeProject || isMutatingTree) return

    const owningProject = activeProject
    const owningProjectId = owningProject.id

    const deletableEntries = entries.filter((entry) => entry.path !== ROOT_PATH)
    if (isEmpty(deletableEntries)) return

    for (const entry of deletableEntries) {
      if (!ensureNoUnsavedFilesInPath(entry.path)) return
    }

    try {
      setIsMutatingTree(true)
      const deletedResults: WorkbenchDeleteEntryResult[] = []
      for (const entry of deletableEntries) {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.deleteWorkbenchEntry({
            projectRoot: owningProject.rootPath,
            path: entry.path,
          })
        )
        deletedResults.push(result)
      }

      if (activeProjectRef.current?.id !== owningProjectId) return

      onTreeChangedLatest.current()
      const parentsToRefresh = new Set<string>()
      for (const result of deletedResults) {
        parentsToRefresh.add(result.parentPath)
        pruneTreeCacheLatest.current(result.deletedPath)
        closeOpenEntryPathLatest.current(result.deletedPath)
        removeWorkbenchCommentsUnderPath(owningProject.rootPath, result.deletedPath)
      }

      await Promise.all(
        [...parentsToRefresh].map((parentPath) => refreshMutationParentLatest.current(parentPath))
      )
      setSelectedEntryPathLatest.current(null)
      resetTreeAction()
      resetSearchLatest.current()
      rememberDeletedEntries(owningProject, deletedResults)
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      notifyTreeMutationError(error)
    } finally {
      setIsMutatingTree(false)
    }
  }

  async function submitTreeAction(): Promise<void> {
    if (!activeProject || !pendingTreeAction || isMutatingTree) return

    const name = treeActionName.trim()
    if (!name) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.entryNameRequired'),
      })
      return
    }

    if (
      pendingTreeAction.kind === 'rename' &&
      pendingTreeAction.entryPath &&
      !ensureNoUnsavedFilesInPath(pendingTreeAction.entryPath)
    ) return

    const owningProject = activeProject
    const owningProjectId = owningProject.id
    const actionSnapshot = pendingTreeAction

    try {
      setIsMutatingTree(true)
      const result =
        actionSnapshot.kind === 'rename'
          ? Result.unwrap(
              await workbenchHost.kernel.project.renameWorkbenchEntry({
                projectRoot: owningProject.rootPath,
                path: actionSnapshot.entryPath ?? '',
                newName: name,
              })
            )
          : Result.unwrap(
              await workbenchHost.kernel.project.createWorkbenchEntry({
                projectRoot: owningProject.rootPath,
                parentPath: actionSnapshot.basePath,
                name,
                type: actionSnapshot.kind === 'create-file' ? 'file' : 'directory',
              })
            )

      if (activeProjectRef.current?.id !== owningProjectId) return

      onTreeChangedLatest.current()
      await refreshMutationParentLatest.current(result.parentPath)
      setSelectedEntryPathLatest.current(result.entry.path)
      resetTreeAction()
      resetSearchLatest.current()

      if (actionSnapshot.kind === 'create-file') {
        await selectFileLatest.current(result.entry.path)
      } else if (actionSnapshot.kind === 'rename') {
        const previousPath = actionSnapshot.entryPath
        if (previousPath && actionSnapshot.entryType === 'directory') {
          pruneTreeCacheLatest.current(previousPath)
        }

        if (previousPath) {
          moveOpenEntryPathLatest.current(previousPath, result.entry.path, result.entry.modifiedAt)
          renameWorkbenchCommentsPath(owningProject.rootPath, previousPath, result.entry.path)
        }
      }

      messageLatest.current.success({
        title:
          actionSnapshot.kind === 'rename'
            ? tLatest.current('workbench.renameSucceeded')
            : tLatest.current('workbench.createSucceeded'),
      })
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      notifyTreeMutationError(error)
    } finally {
      setIsMutatingTree(false)
    }
  }

  async function deleteSelectedEntry(
    entry: Nullable<WorkbenchDirectoryEntry> = selectedEntry
  ): Promise<void> {
    if (!activeProject || !entry || isMutatingTree) return

    if (!ensureNoUnsavedFilesInPath(entry.path)) return

    const owningProject = activeProject
    const owningProjectId = owningProject.id

    try {
      setIsMutatingTree(true)
      const result = Result.unwrap(
        await workbenchHost.kernel.project.deleteWorkbenchEntry({
          projectRoot: owningProject.rootPath,
          path: entry.path,
        })
      )

      if (activeProjectRef.current?.id !== owningProjectId) return

      onTreeChangedLatest.current()
      pruneTreeCacheLatest.current(result.deletedPath)
      await refreshMutationParentLatest.current(result.parentPath)
      setSelectedEntryPathLatest.current(null)
      resetTreeAction()
      resetSearchLatest.current()

      closeOpenEntryPathLatest.current(result.deletedPath)
      rememberDeletedEntries(owningProject, [result])
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      notifyTreeMutationError(error)
    } finally {
      setIsMutatingTree(false)
    }
  }

  async function undoLastDeletedEntries(): Promise<void> {
    const owningProject = activeProjectRef.current
    if (!owningProject || isMutatingTree) return

    const batch = takeLatestDeleteUndoBatch(owningProject)
    if (!batch) return

    try {
      setIsMutatingTree(true)
      const restoredResults: WorkbenchRestoreDeletedEntryResult[] = []
      for (const result of [...batch.results].reverse()) {
        const restored = Result.unwrap(
          await workbenchHost.kernel.project.restoreDeletedWorkbenchEntry({
            projectRoot: batch.projectRoot,
            restoreId: result.restoreId,
          })
        )
        restoredResults.push(restored)
      }

      if (activeProjectRef.current?.id !== owningProject.id) return

      onTreeChangedLatest.current()
      const parentsToRefresh = new Set<string>()
      for (const result of restoredResults) {
        parentsToRefresh.add(result.parentPath)
      }

      await Promise.all(
        [...parentsToRefresh].map((parentPath) => refreshMutationParentLatest.current(parentPath))
      )
      setSelectedEntryPathLatest.current(toNullable(restoredResults.at(-1)?.entry.path))
      resetTreeAction()
      resetSearchLatest.current()
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProject.id) return

      notifyTreeMutationError(error)
    } finally {
      setIsMutatingTree(false)
    }
  }

  /** Workbench AI 命令桥专用：按路径移动并复用与文件树拖拽相同的状态同步。 */
  async function moveEntryByPath(
    fromPath: string,
    toPath: string
  ): Promise<WorkbenchMoveEntryResult> {
    const owningProject = activeProjectRef.current
    if (!owningProject) throw new AppError('NOT_FOUND', '当前没有打开的 Workbench 项目。')
    if (isMutatingTree) throw new AppError('CONFLICT', '文件树正在执行其他变更。')
    if (!ensureNoUnsavedFilesInPath(fromPath)) {
      throw new AppError('CONFLICT', '目标路径包含未保存的编辑器内容。')
    }

    const name = toPath.split('/').filter((value) => !!value).at(-1)?.trim()
    if (!name || fromPath === ROOT_PATH || toPath === ROOT_PATH) {
      throw new AppError('VALIDATION', '移动路径无效或指向项目根目录。')
    }

    try {
      setIsMutatingTree(true)
      const result = Result.unwrap(
        await workbenchHost.kernel.project.moveWorkbenchEntry({
          projectRoot: owningProject.rootPath,
          path: fromPath,
          parentPath: getParentPath(toPath),
          name,
        })
      )
      if (activeProjectRef.current?.id !== owningProject.id) {
        throw new AppError('CONFLICT', 'Workbench 项目在命令执行期间发生了切换。')
      }

      onTreeChangedLatest.current()
      pruneTreeCacheLatest.current(result.previousPath)
      moveOpenEntryPathLatest.current(result.previousPath, result.entry.path, result.entry.modifiedAt)
      renameWorkbenchCommentsPath(owningProject.rootPath, result.previousPath, result.entry.path)
      await Promise.all(
        [...new Set([result.previousParentPath, result.parentPath])].map((parentPath) =>
          refreshMutationParentLatest.current(parentPath)
        )
      )
      setSelectedEntryPathLatest.current(result.entry.path)
      resetSearchLatest.current()
      return result
    } finally {
      setIsMutatingTree(false)
    }
  }

  /** Workbench AI 命令桥专用：走可撤销删除并立即收敛标签页、树缓存和评论。 */
  async function deleteEntryByPath(path: string): Promise<WorkbenchDeleteEntryResult> {
    const owningProject = activeProjectRef.current
    if (!owningProject) throw new AppError('NOT_FOUND', '当前没有打开的 Workbench 项目。')
    if (isMutatingTree) throw new AppError('CONFLICT', '文件树正在执行其他变更。')
    if (path === ROOT_PATH) throw new AppError('VALIDATION', '不能删除项目根目录。')
    if (!ensureNoUnsavedFilesInPath(path)) {
      throw new AppError('CONFLICT', '目标路径包含未保存的编辑器内容。')
    }

    try {
      setIsMutatingTree(true)
      const result = Result.unwrap(
        await workbenchHost.kernel.project.deleteWorkbenchEntry({
          projectRoot: owningProject.rootPath,
          path,
        })
      )
      if (activeProjectRef.current?.id !== owningProject.id) {
        throw new AppError('CONFLICT', 'Workbench 项目在命令执行期间发生了切换。')
      }

      onTreeChangedLatest.current()
      pruneTreeCacheLatest.current(result.deletedPath)
      closeOpenEntryPathLatest.current(result.deletedPath)
      removeWorkbenchCommentsUnderPath(owningProject.rootPath, result.deletedPath)
      await refreshMutationParentLatest.current(result.parentPath)
      setSelectedEntryPathLatest.current(null)
      resetSearchLatest.current()
      rememberDeletedEntries(owningProject, [result])
      return result
    } finally {
      setIsMutatingTree(false)
    }
  }

  return {
    pendingTreeAction,
    treeActionName,
    isMutatingTree,
    setTreeActionName,
    beginCreateEntry,
    beginRenameEntry,
    createTreeEntry,
    renameTreeEntry,
    moveTreeEntries,
    deleteTreeEntries,
    resetTreeAction,
    submitTreeAction,
    deleteSelectedEntry,
    undoLastDeletedEntries,
    moveEntryByPath,
    deleteEntryByPath,
  }
}
