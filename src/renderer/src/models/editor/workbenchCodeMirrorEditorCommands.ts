import { type Extension, Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  resolveWorkbenchEditorCommandFromKey,
  type WorkbenchEditorCommandId,
} from './workbenchEditorCommands'

/**
 * 代码动作的按键（快速修复的 ⌥↩ / ⌘.……）。不走 CodeMirror 的键位表，直接接 keydown 并排在键位表前面：
 * 键位表在 macOS 上认不出带 ⌥ 的字符键（打出来的是别的字符，它不再退回按键位认），这里按物理键位认。
 */
export function workbenchEditorCommandKeys(
  run: (command: WorkbenchEditorCommandId) => void
): Extension {
  return Prec.high(
    EditorView.domEventHandlers({
      keydown: (event) => {
        // 输入法组词期间的按键是给输入法的。
        if (event.isComposing) return false
        const command = resolveWorkbenchEditorCommandFromKey(event)
        if (!command) return false

        event.preventDefault()
        run(command)
        return true
      },
    })
  )
}
