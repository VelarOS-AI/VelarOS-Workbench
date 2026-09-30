import { AppError } from '@velaros-ai/core/error'

import type { WorkbenchDeleteEntryResult, WorkbenchDirectoryEntry } from '@shared/contracts'

import {
  getParentPath,
  isSameOrChildPath,
  ROOT_PATH,
} from '../shared/workbenchUtils'

/**
 * 文件树变更（创建 / 重命名 / 移动 / 删除）的纯逻辑模型。
 *
 * 从 `useWorkbenchMutationController` 抽出与 React 状态无关的路径推导与集合过滤，
 * 行为不变，便于复用与单测。
 */

/** 由当前选中项推导出树操作的目标父目录：目录取自身，文件取父级，否则根。 */
export function resolveTreeActionBasePath(
  selectedEntry: Nullable<WorkbenchDirectoryEntry>,
  selectedEntryPath: Nullable<string>
): string {
  if (selectedEntry?.type === 'directory') return selectedEntry.path

  if (selectedEntryPath) return getParentPath(selectedEntryPath)

  return ROOT_PATH
}

/** 针对显式传入的条目推导基准父目录；缺省时回退到当前选中项的基准。 */
export function resolveTreeActionBasePathForEntry(
  entry: Nullable<WorkbenchDirectoryEntry>,
  fallbackBasePath: string
): string {
  if (entry?.type === 'directory') return entry.path

  if (entry) return getParentPath(entry.path)

  return fallbackBasePath
}

/**
 * 显式的新建请求（右键菜单这类指明了位置的动作）落在哪个目录：给了条目按条目算，没给就是工程根。
 * 不回退到当前选中项——点在根目录或空白处的「新建」不能跑到别的目录里去。
 */
export function resolveTreeCreateParentPath(
  parentEntry: Nullable<WorkbenchDirectoryEntry>
): string {
  return resolveTreeActionBasePathForEntry(parentEntry, ROOT_PATH)
}

/**
 * 过滤出可移动的条目：排除根，并剔除「已被同批次祖先目录覆盖」的冗余子项，
 * 避免父子同时移动产生的重复操作。
 */
export function selectMovableTreeEntries(
  entries: readonly WorkbenchDirectoryEntry[]
): WorkbenchDirectoryEntry[] {
  return entries
    .filter((entry) => entry.path !== ROOT_PATH)
    .filter(
      (entry, _index, allEntries) =>
        !allEntries.some(
          (candidate) =>
            candidate.path !== entry.path && isSameOrChildPath(entry.path, candidate.path)
        )
    )
}

/** 真要移动的条目：在可移动的条目里再去掉本来就在目标目录里的——对它们来说移动什么也不会改变。 */
export function selectTreeEntriesToMove(
  entries: readonly WorkbenchDirectoryEntry[],
  targetParentPath: string
): WorkbenchDirectoryEntry[] {
  return selectMovableTreeEntries(entries).filter(
    (entry) => getParentPath(entry.path) !== targetParentPath
  )
}

/** 留了私有副本、能在应用内撤销的删除结果。 */
export type WorkbenchUndoableDeleteResult = WorkbenchDeleteEntryResult & { restoreId: string }

/**
 * 删掉的东西都在系统废纸篓里；其中小的另留了私有副本（有 restoreId），进撤销栈，⌘Z 可以直接放回。
 * 大的没有副本，只能去废纸篓里找回，界面要告诉用户。
 */
export function partitionDeleteResultsByUndo(results: readonly WorkbenchDeleteEntryResult[]): {
  undoable: WorkbenchUndoableDeleteResult[]
  trashOnly: WorkbenchDeleteEntryResult[]
} {
  const undoable: WorkbenchUndoableDeleteResult[] = []
  const trashOnly: WorkbenchDeleteEntryResult[] = []
  for (const result of results) {
    const { restoreId } = result
    if (restoreId) undoable.push({ ...result, restoreId })
    else trashOnly.push(result)
  }
  return { undoable, trashOnly }
}

/** 多项操作里没成的一项。 */
export interface WorkbenchTreeMutationFailure {
  /** 相对工程根的路径。 */
  path: string
  code: string
  message: string
}

export interface WorkbenchTreeMutationOutcome<TItem, TResult> {
  succeeded: Array<{ item: TItem; result: TResult }>
  failed: Array<{ item: TItem; failure: WorkbenchTreeMutationFailure }>
}

/**
 * 多项移动 / 删除 / 撤销一项一项地做：某一项失败不影响其余的，做成的与没成的分开交回，
 * 调用方据此只更新做成了的那些（标签、撤销栈……），再把没成的报出来。按顺序一项接一项，不并发。
 */
export async function runTreeMutationPerEntry<TItem, TResult>(
  items: readonly TItem[],
  getPath: (item: TItem) => string,
  run: (item: TItem) => Promise<TResult>
): Promise<WorkbenchTreeMutationOutcome<TItem, TResult>> {
  const outcome: WorkbenchTreeMutationOutcome<TItem, TResult> = { succeeded: [], failed: [] }
  for (const item of items) {
    try {
      outcome.succeeded.push({ item, result: await run(item) })
    } catch (error) {
      const appError = AppError.from(error)
      outcome.failed.push({
        item,
        failure: { path: getPath(item), code: appError.code, message: appError.message },
      })
    }
  }
  return outcome
}

type WorkbenchTreeMutationTranslate = (
  key: string,
  params?: Record<string, string | number>
) => string

/** 没成的几项拼成提示正文：列出前几项的路径与原因，其余只报个数。 */
export function describeTreeMutationFailures(
  failures: readonly WorkbenchTreeMutationFailure[],
  translate: WorkbenchTreeMutationTranslate,
  listLimit = 3
): string {
  const items = failures.slice(0, listLimit).map((failure) =>
    translate('workbench.treeMutationFailureItem', {
      path: failure.path,
      message: failure.message.trim().replace(/[。.]+$/u, ''),
    })
  )
  if (failures.length > listLimit) {
    items.push(
      translate('workbench.treeMutationMoreFailures', { count: failures.length - listLimit })
    )
  }
  return items.join(translate('workbench.treeMutationFailureSeparator'))
}

/**
 * 一批撤销删除做完之后还要留在撤销栈里的（按原来的先后）：没放回去、而记录还在的——比如原处又有了
 * 同名的东西，挪开之后还能再撤销。记录已失效（NOT_FOUND）的不留：东西在系统废纸篓里。
 */
export function selectDeleteUndoResultsToKeep<TResult extends WorkbenchDeleteEntryResult>(
  batchResults: readonly TResult[],
  failed: ReadonlyArray<{ item: TResult; failure: WorkbenchTreeMutationFailure }>
): TResult[] {
  const keep = new Set(
    failed.filter(({ failure }) => failure.code !== 'NOT_FOUND').map(({ item }) => item)
  )
  return batchResults.filter((result) => keep.has(result))
}

export type WorkbenchFileTreeShortcutAction =
  | 'delete-selected'
  | 'undo-delete'
  | 'copy-selected'
  | 'cut-selected'
  | 'paste'
  | 'duplicate-selected'

/** ⌘ / Ctrl 加这些键：复制、剪切、粘贴、创建副本（与 VS Code 资源管理器一致）。 */
const ClipboardShortcutActions: Readonly<Record<string, WorkbenchFileTreeShortcutAction>> = {
  c: 'copy-selected',
  x: 'cut-selected',
  v: 'paste',
  d: 'duplicate-selected',
}

interface WorkbenchFileTreeShortcutEventLike {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export function getWorkbenchFileTreeShortcutAction(
  event: WorkbenchFileTreeShortcutEventLike
): Nullable<WorkbenchFileTreeShortcutAction> {
  if (
    (event.key === 'Delete' || event.key === 'Backspace') &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) return 'delete-selected'

  if (
    event.key.toLowerCase() === 'z' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  ) return 'undo-delete'

  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey)
    return ClipboardShortcutActions[event.key.toLowerCase()] ?? null

  return null
}

/**
 * 一组要复制、剪切的项里，已经包含在另一项（选中的目录）里面的去掉：复制目录本来就带着它们。
 */
export function selectTopLevelTreeEntries(
  entries: readonly WorkbenchDirectoryEntry[]
): WorkbenchDirectoryEntry[] {
  return entries.filter(
    (entry) =>
      !entries.some(
        (other) =>
          other !== entry && other.type === 'directory' && entry.path.startsWith(`${other.path}/`)
      )
  )
}
