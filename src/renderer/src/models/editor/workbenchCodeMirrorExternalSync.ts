import { isolateHistory } from '@codemirror/commands'
import { type Annotation, type EditorState, Text, type TransactionSpec } from '@codemirror/state'

import { buildWorkbenchMinimalTextChanges } from './workbenchMinimalTextChanges'

/**
 * 正在编辑的文件，正文在编辑器之外被换掉了（磁盘改动重新载入、别的文件里的重命名改到它、放弃改动）。
 *
 * 按最小改动套进来：没改的地方光标、折叠、评论都留在原处。这一步单独算一次撤销，⌘Z 能退回外部改动之前，
 * 跟 VS Code 重新载入文件一样。只是换行符不同（CRLF 与 LF）不算改动，返回 null。
 */
export function buildWorkbenchExternalValueSyncTransaction(
  state: EditorState,
  value: string,
  annotation: Annotation<unknown>
): Nullable<TransactionSpec> {
  // 按编辑器自己的分行规则比：文档里存的是一行行文本，不含换行符本身。
  const next = state.toText(value)
  if (state.doc.eq(next)) return null

  const changes = buildWorkbenchMinimalTextChanges(state.doc.toString(), next.toString()).map(
    // 插入的内容按行交给编辑器，免得它再按自己的规则把 `\r` 之类拆成新行。
    (change) => ({ from: change.from, to: change.to, insert: Text.of(change.insert.split('\n')) })
  )
  return { changes, annotations: [isolateHistory.of('full'), annotation] }
}
