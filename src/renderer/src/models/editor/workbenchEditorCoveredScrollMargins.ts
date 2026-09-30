import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** 盖在编辑区上面的浮层带着这个属性（底部工具窗那一块）。 */
export const WorkbenchEditorOverlayAttribute = 'data-workbench-editor-overlay'

/** 被盖得再多，也给要滚到的那一行留这么高的地方。 */
const MinVisibleHeightPx = 48

interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * 编辑器滚动区的下面被浮层盖住了多高（没盖住是 0）。只认从下面盖上来的：浮层的下沿到了滚动区的下沿或者
 * 更靠下。横向不相交的（浮层在别的栏里）不算。
 */
export function measureWorkbenchEditorCoveredBottom(
  scroller: RectLike,
  overlays: readonly RectLike[]
): number {
  let covered = 0
  for (const overlay of overlays) {
    if (overlay.bottom <= overlay.top || overlay.right <= overlay.left) continue
    if (overlay.right <= scroller.left || overlay.left >= scroller.right) continue
    if (overlay.bottom < scroller.bottom || overlay.top >= scroller.bottom) continue
    covered = Math.max(covered, scroller.bottom - Math.max(overlay.top, scroller.top))
  }
  return Math.max(0, Math.min(covered, scroller.bottom - scroller.top - MinVisibleHeightPx))
}

/**
 * 底部工具窗（终端、运行、Git、问题、调试）是盖在编辑区上面的一块，不是把编辑区挤矮：编辑器并不知道自己
 * 下面那一截看不见。跳到定义、点一个问题、调试停在断点上、查找下一处，编辑器把那一行滚「进视野」，其实
 * 落在工具窗后面。
 *
 * 这里把被盖住的高度报给 CodeMirror 的 scrollMargins：凡是滚到某个位置的动作（包括跟着光标滚），目标都
 * 落在工具窗的上面。
 */
export function workbenchEditorCoveredScrollMargins(): Extension {
  return EditorView.scrollMargins.of((view) => {
    const overlays = view.dom.ownerDocument.querySelectorAll(`[${WorkbenchEditorOverlayAttribute}]`)
    if (overlays.length === 0) return null
    const bottom = measureWorkbenchEditorCoveredBottom(
      view.scrollDOM.getBoundingClientRect(),
      [...overlays].map((overlay) => overlay.getBoundingClientRect())
    )
    return bottom > 0 ? { bottom } : null
  })
}
