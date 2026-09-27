/**
 * 关闭编辑器标签的纯逻辑：关哪些、问不问、关完选中哪个。
 *
 * 有未保存改动的标签不直接关，先问用户「保存 / 不保存 / 取消」；批量关闭（关闭其他、全部、右侧）
 * 只问一次，列出所有有改动的文件。
 */

/** 用户对「要不要保存」的回答。 */
export type WorkbenchEditorCloseChoice = 'save' | 'discard' | 'cancel'

/** 一次等用户拿主意的关闭。 */
export interface WorkbenchEditorCloseRequest {
  id: number
  /** `tabs`：关标签；`window`：关窗口或退出应用之前。 */
  kind: 'tabs' | 'window'
  /** 要关掉的标签（标签栏顺序）；关窗时为空，整个窗口一起走。 */
  paths: string[]
  /** 其中有未保存改动、要用户决定的标签。 */
  dirtyPaths: string[]
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
