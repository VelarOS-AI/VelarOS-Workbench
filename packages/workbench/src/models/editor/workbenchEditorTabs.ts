import type { SystemWorkspaceFilesChangedEvent, WorkbenchReadFileResult } from '../../contracts/index'
import type {
  WorkbenchOpenEditorExternalChange,
  WorkbenchOpenEditorTab,
} from '../../types/workbenchTypes'
import type { WorkbenchOpenFileSnapshot } from '../project/workbenchProjectContextIndex'
import { fileLanguage } from '../shared/workbenchUtils'

export const WORKBENCH_EDITOR_FILES_CHANGED_DEBOUNCE_MS = 800
export const WORKBENCH_EDITOR_TRANSACTION_FILES_CHANGED_DEBOUNCE_MS = 0

/**
 * 编辑器标签纯逻辑模型。
 *
 * 从 `useWorkbenchEditorController` 抽出与 React 无关的纯函数，
 * 聚焦「标签 / 磁盘快照 / 外部变更」三类计算，便于单测与复用。
 */

export function getWorkbenchEditorFilesChangedRefreshDelayMs(
  event: SystemWorkspaceFilesChangedEvent
): number {
  return event.source === 'file-change-transaction'
    ? WORKBENCH_EDITOR_TRANSACTION_FILES_CHANGED_DEBOUNCE_MS
    : WORKBENCH_EDITOR_FILES_CHANGED_DEBOUNCE_MS
}

/** 标签内容与磁盘版本不一致即视为脏（未保存）。 */
export function isDirtyTab(tab: WorkbenchOpenEditorTab): boolean {
  return tab.content !== tab.file.content
}

/** 标签是否带有外部变更标记。 */
export function hasExternalChange(tab: WorkbenchOpenEditorTab): boolean {
  return !!tab.externalChange
}

/** 比较内存快照与磁盘快照是否发生变化（时间戳 / 大小 / 内容任一不同）。 */
export function hasFileSnapshotChanged(
  currentFile: WorkbenchReadFileResult,
  diskFile: WorkbenchReadFileResult
): boolean {
  return (
    currentFile.modifiedAt !== diskFile.modifiedAt ||
    currentFile.size !== diskFile.size ||
    currentFile.content !== diskFile.content
  )
}

/** 在重命名 / 移动场景下，把一条受影响路径映射到新前缀下。 */
export function movePath(path: string, previousPath: string, nextPath: string): string {
  return path === previousPath ? nextPath : `${nextPath}${path.slice(previousPath.length)}`
}

/** 外部变更通知去重键：同一文件同一状态只提示一次。 */
export function buildExternalChangeNoticeKey(
  path: string,
  change: WorkbenchOpenEditorExternalChange
): string {
  return `${path}:${change.status}:${change.diskFile?.modifiedAt ?? ''}:${change.message ?? ''}`
}

/** 把打开的标签集合投影为「打开文件快照」列表（供语言服务 / 上下文索引使用）。 */
export function toOpenedFileSnapshots(
  openTabs: readonly WorkbenchOpenEditorTab[]
): WorkbenchOpenFileSnapshot[] {
  return openTabs.map((tab) => ({
    path: tab.path,
    content: tab.content,
    language: fileLanguage(tab.path),
  }))
}

function areOpenedFileSnapshotsEqual(
  left: readonly WorkbenchOpenFileSnapshot[],
  right: readonly WorkbenchOpenFileSnapshot[]
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index]
      return (
        !!other &&
        item.path === other.path &&
        item.content === other.content &&
        item.language === other.language
      )
    })
  )
}

export function reuseWorkbenchOpenFileSnapshots(
  previous: WorkbenchOpenFileSnapshot[],
  openTabs: readonly WorkbenchOpenEditorTab[]
): WorkbenchOpenFileSnapshot[] {
  const next = toOpenedFileSnapshots(openTabs)
  return areOpenedFileSnapshotsEqual(previous, next) ? previous : next
}
