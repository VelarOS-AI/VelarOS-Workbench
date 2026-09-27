import { historyField } from '@codemirror/commands'
import { foldState } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'

/** 重建时照搬的状态：撤销历史和折叠（正文、选区总会带上）。 */
const SerializedFields = { history: historyField, folds: foldState }

/**
 * 用当前编辑器实例的扩展重建另一个实例留下的文件状态：正文、选区、撤销历史、折叠照搬，语法树、诊断这类
 * 会重算的不带。
 */
export function rebuildWorkbenchEditorFileState(state: EditorState, extensions: Extension): EditorState {
  return EditorState.fromJSON(state.toJSON(SerializedFields), { extensions }, SerializedFields)
}
