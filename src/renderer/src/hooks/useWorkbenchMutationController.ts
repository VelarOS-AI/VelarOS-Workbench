import { useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import { useWorkbenchCommentStore } from '@renderer/models/comments/workbenchCommentStore'
import {
  describeTreeMutationFailures,
  partitionDeleteResultsByUndo,
  resolveTreeActionBasePath,
  resolveTreeActionBasePathForEntry,
  resolveTreeCreateParentPath,
  runTreeMutationPerEntry,
  selectDeleteUndoResultsToKeep,
  selectMovableTreeEntries,
  selectTreeEntriesToMove,
  type WorkbenchTreeMutationFailure,
  type WorkbenchUndoableDeleteResult,
} from '@renderer/models/files/workbenchTreeMutation'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import { getParentPath, ROOT_PATH } from '@renderer/models/shared/workbenchUtils'
import type { PendingTreeAction } from '@renderer/types/workbenchTypes'

import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type { WorkbenchDeleteEntryResult, WorkbenchDirectoryEntry } from '@shared/contracts'

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
  results: WorkbenchUndoableDeleteResult[]
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
    results: WorkbenchUndoableDeleteResult[]
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

  /**
   * 多项操作里有没成的：只做了一项时照旧报那一项的原因；多项时报没成几项，
   * 并列出前几项的路径与原因。
   * 做成了的那些已经各自更新过了。
   */
  function notifyTreeMutationFailures(
    titleKey: string,
    failures: readonly WorkbenchTreeMutationFailure[],
    attemptedCount: number
  ): void {
    const first = failures[0]
    if (!first) return

    if (attemptedCount === 1) {
      messageLatest.current.error({
        title: tLatest.current('workbench.treeMutationFailed'),
        description: first.message,
      })
      return
    }

    messageLatest.current.error({
      title: tLatest.current(titleKey, { count: failures.length }),
      description: describeTreeMutationFailures(failures, tLatest.current),
    })
  }

  /** 没留私有副本的删除（太大）：不能在这里撤销，告诉用户到系统废纸篓里找回。 */
  function notifyTrashOnlyDeletes(results: readonly WorkbenchDeleteEntryResult[]): void {
    const first = results[0]
    if (!first) return

    messageLatest.current.info({
      title: tLatest.current('workbench.deleteMovedToTrashTitle'),
      description:
        results.length === 1
          ? tLatest.current('workbench.deleteMovedToTrashDescription', {
              name: first.deletedPath.split('/').at(-1) ?? first.deletedPath,
            })
          : tLatest.current('workbench.deleteManyMovedToTrashDescription', {
              count: results.length,
            }),
    })
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

  /** 在指明的位置新建：`parentEntry` 为 null 就是工程根目录，不跟当前选中项走。 */
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
          parentPath: resolveTreeCreateParentPath(parentEntry),
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

  /**
   * 把这些项复制到 `parentEntry` 里（null 是项目根）；复制到原来的目录就是「创建副本」，重名时主进程自动取
   * 「名字 copy」。一项一项地复制，某一项没成不挡住其余的。复制的是磁盘上的内容。
   */
  async function copyTreeEntries(
    entries: WorkbenchDirectoryEntry[],
    parentEntry: Nullable<WorkbenchDirectoryEntry>
  ): Promise<void> {
    if (!activeProject || isMutatingTree || isEmpty(entries)) return

    const owningProject = activeProject
    const owningProjectId = owningProject.id
    const targetParentPath = parentEntry?.path ?? ROOT_PATH

    try {
      setIsMutatingTree(true)
      const { succeeded, failed } = await runTreeMutationPerEntry(
        entries,
        (entry) => entry.path,
        async (entry) =>
          Result.unwrap(
            await workbenchHost.kernel.project.copyWorkbenchEntry({
              projectRoot: owningProject.rootPath,
              path: entry.path,
              parentPath: targetParentPath,
            })
          )
      )

      if (activeProjectRef.current?.id !== owningProjectId) return

      if (!isEmpty(succeeded)) {
        onTreeChangedLatest.current()
        await refreshMutationParentLatest.current(
          succeeded.at(-1)?.result.parentPath ?? targetParentPath
        )
        setSelectedEntryPathLatest.current(toNullable(succeeded.at(-1)?.result.entry.path))
        resetTreeAction()
        resetSearchLatest.current()
      }

      if (isEmpty(failed)) {
        messageLatest.current.success({
          title: tLatest.current('workbench.copySucceeded'),
        })
        return
      }
      notifyTreeMutationFailures(
        'workbench.copyFailedEntries',
        failed.map(({ failure }) => failure),
        entries.length
      )
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      notifyTreeMutationError(error)
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

    const targetParentPath = parentEntry?.path ?? ROOT_PATH
    const movableEntries = selectTreeEntriesToMove(entries, targetParentPath)
    if (isEmpty(movableEntries)) return

    for (const entry of movableEntries) {
      if (!ensureNoUnsavedFilesInPath(entry.path)) return
    }

    try {
      setIsMutatingTree(true)
      // 一项一项地挪：某一项没成（重名之类）不挡住其余的，挪成了的都要跟着换标签与评论的路径。
      const { succeeded, failed } = await runTreeMutationPerEntry(
        movableEntries,
        (entry) => entry.path,
        async (entry) =>
          Result.unwrap(
            await workbenchHost.kernel.project.moveWorkbenchEntry({
              projectRoot: owningProject.rootPath,
              path: entry.path,
              parentPath: targetParentPath,
              name: entry.name,
            })
          )
      )

      if (activeProjectRef.current?.id !== owningProjectId) return

      if (!isEmpty(succeeded)) {
        onTreeChangedLatest.current()
        const parentsToRefresh = new Set<string>()
        for (const { item: source, result } of succeeded) {
          parentsToRefresh.add(result.previousParentPath)
          parentsToRefresh.add(result.parentPath)
          if (source.type === 'directory') {
            pruneTreeCacheLatest.current(result.previousPath)
          }
          moveOpenEntryPathLatest.current(
            result.previousPath,
            result.entry.path,
            result.entry.modifiedAt
          )
          commentStore.renamePath(owningProject.rootPath, result.previousPath, result.entry.path)
        }

        await Promise.all(
          [...parentsToRefresh].map((parentPath) => refreshMutationParentLatest.current(parentPath))
        )
        setSelectedEntryPathLatest.current(toNullable(succeeded.at(-1)?.result.entry.path))
        resetTreeAction()
        resetSearchLatest.current()
      }

      if (isEmpty(failed)) {
        messageLatest.current.success({
          title: tLatest.current('workbench.moveSucceeded'),
        })
        return
      }
      notifyTreeMutationFailures(
        'workbench.moveFailedEntries',
        failed.map(({ failure }) => failure),
        movableEntries.length
      )
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
      // 先逐项看一眼要不要确认：看不了的（已经被别处删掉之类）记下来最后报，不挡住其余的。
      const inspected = await runTreeMutationPerEntry(
        deletableEntries,
        (entry) => entry.path,
        async (entry) =>
          Result.unwrap(
            await workbenchHost.kernel.project.inspectWorkbenchDeleteEntry({
              projectRoot: owningProject.rootPath,
              path: entry.path,
            })
          )
      )
      const failures = inspected.failed.map(({ failure }) => failure)
      const deletePreviews = inspected.succeeded.map(({ item, result }) => ({
        entry: item,
        preview: result,
      }))
      if (isEmpty(deletePreviews)) {
        notifyTreeMutationFailures(
          'workbench.deleteFailedEntries',
          failures,
          deletableEntries.length
        )
        return
      }

      const confirmationEntries = deletePreviews.filter(
        ({ preview }) => preview.requiresConfirmation
      )
      if (!isEmpty(confirmationEntries)) {
        const confirmationMessage =
          deletePreviews.length === 1
            ? tLatest.current(
                confirmationEntries[0]!.preview.type === 'directory'
                  ? 'workbench.deleteDirectoryConfirm'
                  : 'workbench.deleteConfirm',
                { name: confirmationEntries[0]!.entry.name }
              )
            : tLatest.current('workbench.deleteManyConfirm', {
                count: deletePreviews.length,
              })
        if (!window.confirm(confirmationMessage)) return
      }

      if (activeProjectRef.current?.id !== owningProjectId) return

      // 一项一项地移到废纸篓：某一项没成不挡住其余的；移走了的都要关掉标签、进撤销栈。
      const deleted = await runTreeMutationPerEntry(
        deletePreviews,
        ({ entry }) => entry.path,
        async ({ entry, preview }) =>
          Result.unwrap(
            await workbenchHost.kernel.project.deleteWorkbenchEntry({
              projectRoot: owningProject.rootPath,
              path: entry.path,
              recursive: preview.type === 'directory' && preview.requiresConfirmation,
            })
          )
      )
      failures.push(...deleted.failed.map(({ failure }) => failure))
      const deletedResults = deleted.succeeded.map(({ result }) => result)
      // 移走了的都记进撤销栈：不管有没有别的没成、项目有没有切走（撤销栈按项目记）。
      const { undoable, trashOnly } = partitionDeleteResultsByUndo(deletedResults)
      rememberDeletedEntries(owningProject, undoable)

      if (activeProjectRef.current?.id !== owningProjectId) return

      if (!isEmpty(deletedResults)) {
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
      }
      notifyTrashOnlyDeletes(trashOnly)
      notifyTreeMutationFailures('workbench.deleteFailedEntries', failures, deletableEntries.length)
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
      // 倒着一项一项放回：某一项放不回（原处又有了同名的东西之类）不挡住其余的。放不回而记录还在的
      // 重新放回撤销栈，挪开冲突之后还能再撤销。
      const { succeeded, failed } = await runTreeMutationPerEntry(
        [...batch.results].reverse(),
        (result) => result.deletedPath,
        async (result) =>
          Result.unwrap(
            await workbenchHost.kernel.project.restoreDeletedWorkbenchEntry({
              projectRoot: batch.projectRoot,
              restoreId: result.restoreId,
            })
          )
      )
      rememberDeletedEntries(owningProject, selectDeleteUndoResultsToKeep(batch.results, failed))

      if (activeProjectRef.current?.id !== owningProject.id) return

      if (!isEmpty(succeeded)) {
        onTreeChangedLatest.current()
        const parentsToRefresh = new Set(succeeded.map(({ result }) => result.parentPath))
        await Promise.all(
          [...parentsToRefresh].map((parentPath) => refreshMutationParentLatest.current(parentPath))
        )
        setSelectedEntryPathLatest.current(toNullable(succeeded.at(-1)?.result.entry.path))
        resetTreeAction()
        resetSearchLatest.current()
      }
      notifyTreeMutationFailures(
        'workbench.undoDeleteFailedEntries',
        failed.map(({ failure }) => failure),
        batch.results.length
      )
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
    copyTreeEntries,
    deleteTreeEntries,
    resetTreeAction,
    submitTreeAction,
    deleteSelectedEntry,
    undoLastDeletedEntries,
  }
}
