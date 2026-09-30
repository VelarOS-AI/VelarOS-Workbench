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

/** 拖的是编辑器标签时拖放数据里带的类型：别的拖放（文件树里的文件、文字）标签栏与编辑区的各组不接。 */
export const WorkbenchEditorTabDragType = 'application/x-velaros-workbench-editor-tab'

let activeTabDrag: Nullable<WorkbenchEditorTabDrag> = null

export function beginWorkbenchEditorTabDrag(drag: WorkbenchEditorTabDrag): void {
  activeTabDrag = drag
}

/**
 * 正在进行的这次拖放拖的是哪个编辑器标签。`types` 是拖放数据里带的类型（dragover 时只读得到类型）：拖的是
 * 别的东西（文件树里的文件、文字）为 null。
 */
export function readWorkbenchEditorTabDrag(
  types: readonly string[]
): Nullable<WorkbenchEditorTabDrag> {
  return types.includes(WorkbenchEditorTabDragType) ? activeTabDrag : null
}

export function endWorkbenchEditorTabDrag(): void {
  activeTabDrag = null
}

/**
 * 另一组拖过来的标签能不能落在这一组标签栏以外的地方（编辑器、预览）：松手挪进这一组、加到末尾。同一组的
 * 标签不接——在自己这一组里换位置只在标签栏上做。
 */
export function canDropWorkbenchEditorTabOnGroup(
  drag: Nullable<WorkbenchEditorTabDrag>,
  groupIndex: number
): boolean {
  return !!drag && drag.groupIndex !== groupIndex
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
