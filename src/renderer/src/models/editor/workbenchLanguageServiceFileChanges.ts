import { AppError } from '@velaros-ai/core/error'
import type { Result } from '@velaros-ai/core/result'

import type {
  WorkbenchLanguageServiceFileEdit,
  WorkbenchReadFileResult,
  WorkbenchSaveFileRequest,
  WorkbenchSaveFileResult,
} from '@shared/contracts'

import { applyWorkbenchLanguageServiceEditsToContent } from './workbenchCodeMirrorLanguageService'
import { canEditWorkbenchFileContent, resolveWorkbenchEditorEditMode } from './workbenchEditorEditMode'

/** 语言服务的跨文件改动落不到某个文件的原因。 */
export type WorkbenchLanguageServiceFileChangeFailureReason =
  | 'read-only'
  | 'unsupported-text'
  | 'changed-on-disk'
  | 'error'

export interface WorkbenchLanguageServiceFileChangeFailure {
  path: string
  reason: WorkbenchLanguageServiceFileChangeFailureReason
  /** `error` 时的具体说明。 */
  message?: string
}

export interface WorkbenchLanguageServiceDiskPorts {
  readFile(path: string): Promise<WorkbenchReadFileResult>
  saveFile(
    request: Pick<WorkbenchSaveFileRequest, 'path' | 'content' | 'expectedModifiedAt' | 'expectedSize'>
  ): Promise<Result<WorkbenchSaveFileResult>>
}

/**
 * 没有打开的文件：读盘、套上改动、经主进程的保存管线写回。不带编码与换行符，写回时沿用磁盘上的格式；带上读到
 * 的修改时间与大小，读完之后文件又被别人改过就不写（报「磁盘上已改动」）。被 Git 忽略的文件（依赖、构建产物）
 * 与编辑器里一样按只读处理。返回 null 表示写好了（或本来就不用改）。
 */
export async function writeWorkbenchLanguageServiceFileChange(
  change: WorkbenchLanguageServiceFileEdit,
  ports: WorkbenchLanguageServiceDiskPorts
): Promise<Nullable<WorkbenchLanguageServiceFileChangeFailure>> {
  let file: WorkbenchReadFileResult
  try {
    file = await ports.readFile(change.path)
  } catch (error) {
    return { path: change.path, reason: 'error', message: AppError.from(error).message }
  }
  if (!canEditWorkbenchFileContent(file)) return { path: change.path, reason: 'unsupported-text' }
  if (resolveWorkbenchEditorEditMode(file, undefined) !== 'edit') return { path: change.path, reason: 'read-only' }

  const content = applyWorkbenchLanguageServiceEditsToContent(file.content, change.edits)
  if (content === file.content) return null

  const saved = await ports.saveFile({
    path: change.path,
    content,
    expectedModifiedAt: file.modifiedAt,
    expectedSize: file.size,
  })
  if (saved.ok) return null
  return saved.error.code === 'CONFLICT'
    ? { path: change.path, reason: 'changed-on-disk' }
    : { path: change.path, reason: 'error', message: saved.error.message }
}
