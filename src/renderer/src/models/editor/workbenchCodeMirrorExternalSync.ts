import { isolateHistory } from '@codemirror/commands'
import type { Annotation, EditorState, TransactionSpec } from '@codemirror/state'

import { buildWorkbenchMinimalTextChanges } from './workbenchMinimalTextChanges'

/**
 * 正在编辑的文件，正文在编辑器之外被换掉了（磁盘改动重新载入、别的文件里的重命名改到它、放弃改动）。
 *
 * 按最小改动套进来：没改的地方光标、折叠、评论都留在原处。这一步单独算一次撤销，⌘Z 能退回外部改动之前，
 * 跟 VS Code 重新载入文件一样。
 */
export function buildWorkbenchExternalValueSyncTransaction(
  state: EditorState,
  value: string,
  annotation: Annotation<unknown>
): TransactionSpec {
  return {
    changes: buildWorkbenchMinimalTextChanges(state.doc.toString(), value),
    annotations: [isolateHistory.of('full'), annotation],
  }
}
