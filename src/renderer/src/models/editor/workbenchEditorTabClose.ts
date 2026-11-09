/**
 * 关闭编辑器标签的纯逻辑：关哪些、问不问、关完选中哪个。
 *
 * 有未保存改动的标签不直接关，先问用户「保存 / 不保存 / 取消」；批量关闭（关闭其他、全部、右侧）
 * 只问一次，列出所有有改动的文件。
 */

import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'
import { isSameOrChildPath } from '../shared/workbenchUtils'

import { isDirtyTab } from './workbenchEditorTabs'

/** 用户对「要不要保存」的回答。 */
export type WorkbenchEditorCloseChoice = 'save' | 'discard' | 'cancel'

/** 关窗确认因何而起：关这一个窗口，还是退出应用。 */
export type WorkbenchEditorWindowCloseReason = 'close' | 'quit'

/** 一次等用户拿主意的关闭。 */
export interface WorkbenchEditorCloseRequest {
  id: number
  /** `tabs`：关标签；`window`：关窗口或退出应用之前。 */
  kind: 'tabs' | 'window'
  /** 关窗确认因何而起；只有 `window` 有。 */
  windowReason?: WorkbenchEditorWindowCloseReason
  /** 要关掉的标签（标签栏顺序）；关窗时为空，整个窗口一起走。 */
  paths: string[]
  /** 其中有未保存改动、要用户决定的标签。 */
  dirtyPaths: string[]
  /** 已经试过、没存下的文件的原因（按路径），确认框里写给用户看。 */
  reasons?: Readonly<Record<string, string>>
}

/**
 * 关掉一批标签之后该选中哪个：当前标签没被关就不动；被关了就选它左边最近一个留下来的标签，
 * 左边没有就选右边第一个，全关了返回 null。
 */
export function resolveWorkbenchEditorSelectionAfterClose(
  orderedPaths: readonly string[],
  closingPaths: ReadonlySet<string>,
  selectedPath: Nullable<string>
): Nullable<string> {
  if (!selectedPath || !closingPaths.has(selectedPath)) return selectedPath

  const selectedIndex = orderedPaths.indexOf(selectedPath)
  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    const path = orderedPaths[index]
    if (path && !closingPaths.has(path)) return path
  }
  for (let index = selectedIndex + 1; index < orderedPaths.length; index += 1) {
    const path = orderedPaths[index]
    if (path && !closingPaths.has(path)) return path
  }
  return null
}

/**
 * 从当前标签持有的正文与格式收集未保存路径；之前某次写盘成功不代表现在的草稿已经落盘。
 */
export function collectWorkbenchEditorUnsavedPaths(tabs: Iterable<WorkbenchOpenEditorTab>): string[] {
  return [...tabs].filter(isDirtyTab).map((tab) => tab.path)
}

/** 删除已落盘：clean标签可关，等待删除期间产生的草稿留给现有已删文件恢复流程。 */
export function resolveWorkbenchEditorDeletedEntry(
  tabs: Iterable<WorkbenchOpenEditorTab>,
  deletedPath: string,
  detectedAt: number
): { closingPaths: string[]; retainedTabs: WorkbenchOpenEditorTab[] } {
  const closingPaths: string[] = []
  const retainedTabs: WorkbenchOpenEditorTab[] = []
  for (const tab of tabs) {
    if (!isSameOrChildPath(tab.path, deletedPath)) continue
    if (isDirtyTab(tab)) {
      retainedTabs.push({ ...tab, externalChange: { status: 'deleted', detectedAt } })
    } else {
      closingPaths.push(tab.path)
    }
  }
  return { closingPaths, retainedTabs }
}

/** 「重新打开关闭的标签」最多记住多少个。 */
export const WORKBENCH_CLOSED_EDITOR_TAB_LIMIT = 20

/**
 * 记下刚关掉的标签（按标签栏顺序，最近关的在末尾）：同一个文件只留最近一次，最多留 20 个。
 */
export function pushWorkbenchClosedEditorTabs(
  stack: readonly string[],
  closedPaths: readonly string[]
): string[] {
  const closing = new Set(closedPaths)
  return [...stack.filter((path) => !closing.has(path)), ...closedPaths].slice(
    -WORKBENCH_CLOSED_EDITOR_TAB_LIMIT
  )
}

/** 取出最近关掉、此刻又没打开着的那个标签；返回它与剩下的记录。 */
export function popWorkbenchClosedEditorTab(
  stack: readonly string[],
  openPaths: ReadonlySet<string>
): { path: Nullable<string>; stack: string[] } {
  const remaining = [...stack]
  while (remaining.length > 0) {
    const path = remaining.pop()
    if (path && !openPaths.has(path)) return { path, stack: remaining }
  }
  return { path: null, stack: [] }
}

/** 某个标签右边的所有标签。 */
export function collectWorkbenchEditorTabsToRight(
  orderedPaths: readonly string[],
  path: string
): string[] {
  const index = orderedPaths.indexOf(path)
  return index < 0 ? [] : orderedPaths.slice(index + 1)
}

/** 文件名（路径最后一段）。 */
export function workbenchEditorTabFileName(path: string): string {
  return path.split('/').findLast((segment) => !!segment) ?? path
}
