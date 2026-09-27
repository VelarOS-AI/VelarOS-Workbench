import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** 只读时连补全、粘贴、拖放这类不看只读标记的输入也拦下；外部同步、程序改动不受影响。 */
const readOnlyInputGuard = EditorState.changeFilter.of(
  (tr) => !tr.isUserEvent('input') && !tr.isUserEvent('delete') && !tr.isUserEvent('move')
)

/**
 * 只读的文件照样能点进去：放光标、用键盘移动和选中、复制、查找，只是改不了（跟 VS Code、WebStorm 一样）。
 * 禁用时整个编辑区不可聚焦。
 */
export function buildWorkbenchReadOnlyExtensions(readOnly: boolean, disabled: boolean): Extension {
  if (disabled) return [EditorState.readOnly.of(true), EditorView.editable.of(false)]
  return readOnly ? [EditorState.readOnly.of(true), readOnlyInputGuard] : []
}
