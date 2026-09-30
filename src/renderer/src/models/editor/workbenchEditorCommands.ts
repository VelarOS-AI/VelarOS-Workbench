/**
 * 编辑器里作用在光标处的命令：改代码的动作（快速修复、重构……）与跟着符号走的导航（查找引用……）。按键、
 * 右键菜单、命令面板都落到这里登记的命令上；命令怎么做在编辑器组件里。哪个键是哪个命令在键位表里
 * （`workbenchEditorKeymap.ts`，随键位方案变）。
 */

/** 改代码的动作：只读的文件不给。 */
export type WorkbenchEditorCodeActionCommandId = 'organize-imports' | 'quick-fix' | 'refactor'

/** 跟着光标处的符号走的导航：不改代码，只读的文件也能用。 */
export type WorkbenchEditorNavigationCommandId = 'call-hierarchy' | 'find-references'

export type WorkbenchEditorCommandId =
  | WorkbenchEditorCodeActionCommandId
  | WorkbenchEditorNavigationCommandId

export function isWorkbenchEditorNavigationCommand(
  command: WorkbenchEditorCommandId
): command is WorkbenchEditorNavigationCommandId {
  return command === 'find-references' || command === 'call-hierarchy'
}

/** 页面（命令面板）交给编辑器去做的一次命令；每次序号加一，同一个命令连做两次也分得开。 */
export interface WorkbenchEditorCommandRequest {
  id: number
  command: WorkbenchEditorCommandId
}
