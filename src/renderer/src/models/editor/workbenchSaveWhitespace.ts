import type { ChangeSpec, EditorState } from '@codemirror/state'

import type { WorkbenchEditorConfigProperties } from './workbenchEditorConfig'

/**
 * 按 `.editorconfig` 在保存时收拾空白：`trim_trailing_whitespace` 去掉行尾空白，`insert_final_newline` 让文件以
 * 一个换行结尾（false 时去掉结尾多余的换行）。没写这两项就什么都不改。
 */
export function buildWorkbenchSaveWhitespaceChanges(
  state: EditorState,
  editorConfig: Nullable<WorkbenchEditorConfigProperties>
): ChangeSpec[] {
  if (!editorConfig) return []

  const changes: ChangeSpec[] = []
  const { doc } = state
  if (editorConfig.trimTrailingWhitespace) {
    for (let number = 1; number <= doc.lines; number += 1) {
      const line = doc.line(number)
      const trailing = /[ \t]+$/u.exec(line.text)
      if (trailing) changes.push({ from: line.to - trailing[0].length, to: line.to })
    }
  }
  if (editorConfig.insertFinalNewline === true && doc.length > 0 && !doc.sliceString(doc.length - 1).includes('\n'))
    changes.push({ from: doc.length, insert: state.lineBreak })
  if (editorConfig.insertFinalNewline === false) {
    const trailingNewlines = /\n+$/u.exec(doc.sliceString(Math.max(0, doc.length - 64)))
    if (trailingNewlines) changes.push({ from: doc.length - trailingNewlines[0].length, to: doc.length })
  }
  return changes
}
