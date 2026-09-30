/**
 * 正在拖的那个编辑器标签。编辑区并排两组时各有各的标签栏组件，拖到另一组的标签栏上要知道拖的是谁、
 * 从哪一组来、是不是固定标签；浏览器在 dragover 时读不到拖放数据的内容，所以另记在这里。窗口里同一时刻
 * 只有一次拖放。
 */
export interface WorkbenchEditorTabDrag {
  path: string
  /** 标签原来在哪一组（0 左，1 右）。 */
  groupIndex: number
  /** 拖的是固定标签：同一组里只能落在固定标签上。 */
  pinned: boolean
}

let activeTabDrag: Nullable<WorkbenchEditorTabDrag> = null

export function beginWorkbenchEditorTabDrag(drag: WorkbenchEditorTabDrag): void {
  activeTabDrag = drag
}

export function readWorkbenchEditorTabDrag(): Nullable<WorkbenchEditorTabDrag> {
  return activeTabDrag
}

export function endWorkbenchEditorTabDrag(): void {
  activeTabDrag = null
}

/**
 * 这次拖放能不能落在某个标签上。同一组里：固定标签只能落在固定标签上，普通标签只能落在普通标签上，也不能
 * 落在自己身上。另一组的标签都能落（落点由布局收进对应的区里：进不了对方的固定区）。
 */
export function canDropWorkbenchEditorTabOn(
  drag: Nullable<WorkbenchEditorTabDrag>,
  target: { path: string; groupIndex: number; pinned: boolean }
): boolean {
  if (!drag) return false
  if (drag.groupIndex !== target.groupIndex) return true
  return drag.path !== target.path && drag.pinned === target.pinned
}
