import { useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import { useWorkbenchCommentStore } from '@renderer/models/comments/workbenchCommentStore'
import {
  resolveTreeActionBasePath,
  resolveTreeActionBasePathForEntry,
  selectMovableTreeEntries,
} from '@renderer/models/files/workbenchTreeMutation'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import { getParentPath, ROOT_PATH } from '@renderer/models/shared/workbenchUtils'
import type { PendingTreeAction } from '@renderer/types/workbenchTypes'

import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type {
  WorkbenchDeleteEntryResult, WorkbenchDirectoryEntry, WorkbenchMoveEntryResult, WorkbenchRestoreDeletedEntryResult, } from '@shared/contracts'

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
  const commentStore = useWorkbenchCommentStore()
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
      commentStore.renamePath(owningProject.rootPath, entry.path, result.entry.path)
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
        commentStore.renamePath(owningProject.rootPath, result.previousPath, result.entry.path)
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

    const deletableEntries = selectMovableTreeEntries(entries)
    if (isEmpty(deletableEntries)) return

    for (const entry of deletableEntries) {
      if (!ensureNoUnsavedFilesInPath(entry.path)) return
    }

    try {
      setIsMutatingTree(true)
      const deletePreviews = await Promise.all(
        deletableEntries.map(async (entry) => ({
          entry,
          preview: Result.unwrap(
            await workbenchHost.kernel.project.inspectWorkbenchDeleteEntry({
              projectRoot: owningProject.rootPath,
              path: entry.path,
            })
          ),
        }))
      )
      const confirmationEntries = deletePreviews.filter(
        ({ preview }) => preview.requiresConfirmation
      )
      if (!isEmpty(confirmationEntries)) {
        const confirmationMessage =
          deletableEntries.length === 1
            ? tLatest.current(
                confirmationEntries[0]!.preview.type === 'directory'
                  ? 'workbench.deleteDirectoryConfirm'
                  : 'workbench.deleteConfirm',
                { name: confirmationEntries[0]!.entry.name }
              )
            : tLatest.current('workbench.deleteManyConfirm', {
                count: deletableEntries.length,
              })
        if (!window.confirm(confirmationMessage)) return
      }

      if (activeProjectRef.current?.id !== owningProjectId) return

      const deletedResults: WorkbenchDeleteEntryResult[] = []
      for (const { entry, preview } of deletePreviews) {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.deleteWorkbenchEntry({
            projectRoot: owningProject.rootPath,
            path: entry.path,
            recursive: preview.type === 'directory' && preview.requiresConfirmation,
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
        commentStore.removeUnderPath(owningProject.rootPath, result.deletedPath)
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
          commentStore.renamePath(owningProject.rootPath, previousPath, result.entry.path)
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
    if (!entry) return

    await deleteTreeEntries([entry])
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
  }
}
