import type { WorkbenchReadFileResult } from '@shared/contracts'

/** 编辑器里一个文件的编辑模式：只读时键入与改名重构都不落到这个文件，编辑时照常修改和保存。 */
export type WorkbenchEditorEditMode = 'edit' | 'read-only'

/** 图片预览和被截断的大文件手上没有完整文本，任何模式下都不能在编辑器里改。 */
export function canEditWorkbenchFileContent(
  file: Pick<WorkbenchReadFileResult, 'imagePreview' | 'truncated'>
): boolean {
  return !file.imagePreview && !file.truncated
}

/**
 * 文件当前的编辑模式：用户切换过就按用户的选择；没切换过时，被 Git 忽略的文件（构建产物、依赖、
 * 本地配置）默认只读、防止误改，其余文件默认可编辑。
 */
export function resolveWorkbenchEditorEditMode(
  file: Pick<WorkbenchReadFileResult, 'gitIgnored'>,
  chosenMode: LooseOptional<WorkbenchEditorEditMode>
): WorkbenchEditorEditMode {
  return chosenMode ?? (file.gitIgnored ? 'read-only' : 'edit')
}

/** 编辑器里此刻能不能改这个文件：文本完整，且处在编辑模式。 */
export function isWorkbenchFileEditable(
  file: Pick<WorkbenchReadFileResult, 'gitIgnored' | 'imagePreview' | 'truncated'>,
  chosenMode: LooseOptional<WorkbenchEditorEditMode>
): boolean {
  return canEditWorkbenchFileContent(file) && resolveWorkbenchEditorEditMode(file, chosenMode) === 'edit'
}
