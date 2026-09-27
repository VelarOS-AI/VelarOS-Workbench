import type { SystemWorkspaceFilesChangedEvent, WorkbenchReadFileResult } from '@shared/contracts'

import type {
  WorkbenchOpenEditorExternalChange,
  WorkbenchOpenEditorTab,
} from '../../types/workbenchTypes'
import type { WorkbenchOpenFileSnapshot } from '../project/workbenchProjectContextIndex'
import { fileLanguage } from '../shared/workbenchUtils'

export const WORKBENCH_EDITOR_FILES_CHANGED_DEBOUNCE_MS = 800
export const WORKBENCH_EDITOR_TRANSACTION_FILES_CHANGED_DEBOUNCE_MS = 0
/** 打开文件时读取的字符上限：超过的截断、只读。 */
export const WORKBENCH_EDITOR_READ_MAX_CHARS = 300_000

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

/**
 * 这批文件事件会不会改变语言服务的结论（依赖文件、配置都算，不只是打开的那几个）：
 * 只有版本库内部状态（`.git/…`）变了不算。
 */
export function mayAffectWorkbenchDiagnostics(event: SystemWorkspaceFilesChangedEvent): boolean {
  return event.paths.some((path) => path !== '.git' && !path.startsWith('.git/'))
}

/** 标签内容与磁盘版本不一致、或选了还没存下去的格式转换，即视为脏（未保存）。 */
export function isDirtyTab(
  tab: Pick<WorkbenchOpenEditorTab, 'content' | 'file' | 'textConversion'>
): boolean {
  return !tab.file.imagePreview && (tab.content !== tab.file.content || !!tab.textConversion)
}

/** 标签是否带有外部变更标记。 */
export function hasExternalChange(tab: WorkbenchOpenEditorTab): boolean {
  return !!tab.externalChange
}

/** 比较内存快照与磁盘快照是否发生变化（时间戳 / 大小 / 内容 / 编码与换行符任一不同）。 */
export function hasFileSnapshotChanged(
  currentFile: WorkbenchReadFileResult,
  diskFile: WorkbenchReadFileResult
): boolean {
  return (
    currentFile.modifiedAt !== diskFile.modifiedAt ||
    currentFile.size !== diskFile.size ||
    currentFile.content !== diskFile.content ||
    currentFile.encoding !== diskFile.encoding ||
    currentFile.eol !== diskFile.eol ||
    currentFile.textIssue !== diskFile.textIssue ||
    !sameImagePreview(currentFile.imagePreview, diskFile.imagePreview)
  )
}

function sameImagePreview(
  left: WorkbenchReadFileResult['imagePreview'],
  right: WorkbenchReadFileResult['imagePreview']
): boolean {
  if (!left || !right) return left === right
  if (left.mediaType !== right.mediaType || left.data.byteLength !== right.data.byteLength)
    return false

  return left.data.every((byte, index) => byte === right.data[index])
}

/**
 * 重读一个打开的文件时的字符上限：至少是打开时的上限；标签握着完整正文（没截断）时至少读到它的
 * 长度——在编辑器里写到上限以上、保存过的文件，按打开时的上限重读回来是截断的，会被当成外部修改，
 * 或者变成只读。
 */
export function resolveWorkbenchEditorRereadMaxChars(
  file: LooseOptional<Pick<WorkbenchReadFileResult, 'content' | 'imagePreview' | 'truncated'>>
): number {
  if (!file || file.imagePreview || file.truncated) return WORKBENCH_EDITOR_READ_MAX_CHARS

  return Math.max(WORKBENCH_EDITOR_READ_MAX_CHARS, file.content.length)
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

/** 将主进程语义错误映射成编辑器可操作的外部文件状态。 */
export function resolveExternalFileUnavailableStatus(
  errorCode: Nullable<string>
): WorkbenchOpenEditorExternalChange['status'] {
  return errorCode === 'NOT_FOUND' ? 'deleted' : 'unavailable'
}

/** 把打开的标签集合投影为「打开文件快照」列表（供语言服务 / 上下文索引使用）。 */
export function toOpenedFileSnapshots(
  openTabs: readonly WorkbenchOpenEditorTab[]
): WorkbenchOpenFileSnapshot[] {
  return openTabs.flatMap((tab) =>
    tab.file.imagePreview
      ? []
      : [{
          path: tab.path,
          content: tab.content,
          language: fileLanguage(tab.path),
        }]
  )
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
