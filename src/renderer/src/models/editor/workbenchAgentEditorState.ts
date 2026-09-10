import type { WorkbenchAgentEditorState } from '@shared/workbenchAgentUi'

/** 选中的代码最多回这么多字符；再多让模型按行号去读。 */
const SelectionTextLimit = 4000

interface EditorCursorSnapshot {
  line: number
  column: number
  selection?: {
    startLine: number
    endLine: number
    startColumn: number
    endColumn: number
  }
}

/** 按 1 基行列从文档里切出选区文字。 */
function sliceSelection(
  content: string,
  selection: NonNullable<EditorCursorSnapshot['selection']>
): string {
  const lines = content.split('\n')
  const startLine = Math.max(1, selection.startLine)
  const endLine = Math.min(lines.length, Math.max(startLine, selection.endLine))
  const picked = lines.slice(startLine - 1, endLine)
  if (picked.length === 0) return ''
  picked[picked.length - 1] = picked[picked.length - 1].slice(0, Math.max(0, selection.endColumn - 1))
  picked[0] = picked[0].slice(Math.max(0, selection.startColumn - 1))
  return picked.join('\n')
}

/**
 * `workbench:get_editor_state` 的回执：用户此刻在编辑区看的是什么。
 *
 * 选区只在普通文件视图里有意义；对比、结构图这类只读视图下光标不属于任何可编辑文件，只报视图种类。
 */
export function buildWorkbenchAgentEditorState(input: {
  view: WorkbenchAgentEditorState['view']
  selectedFilePath: string | null
  cursor: EditorCursorSnapshot
  editorContent: string
  openTabs: ReadonlyArray<{ path: string; content: string; file: { content: string } }>
  explanationCount: number
}): WorkbenchAgentEditorState {
  const unsavedPaths = new Set(
    input.openTabs.filter((tab) => tab.content !== tab.file.content).map((tab) => tab.path)
  )
  const showsFile = input.view === 'file' && !!input.selectedFilePath
  const selection = showsFile ? input.cursor.selection : undefined
  const hasSelection =
    !!selection &&
    (selection.startLine !== selection.endLine || selection.startColumn !== selection.endColumn)
  const selectionText = hasSelection ? sliceSelection(input.editorContent, selection) : ''

  return {
    view: input.view,
    activeFile:
      showsFile && input.selectedFilePath
        ? {
            path: input.selectedFilePath,
            line: input.cursor.line,
            column: input.cursor.column,
            unsaved: unsavedPaths.has(input.selectedFilePath),
          }
        : null,
    selection:
      hasSelection && selection
        ? {
            startLine: selection.startLine,
            endLine: selection.endLine,
            text: selectionText.slice(0, SelectionTextLimit),
            truncated: selectionText.length > SelectionTextLimit,
          }
        : null,
    openFiles: input.openTabs.map((tab) => ({ path: tab.path, unsaved: unsavedPaths.has(tab.path) })),
    explanationCount: input.explanationCount,
  }
}
