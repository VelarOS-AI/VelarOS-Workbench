import { AppError } from '@velaros-ai/core/error'
import type { Result } from '@velaros-ai/core/result'

import { type WorkbenchCreateEntryRequest, type WorkbenchEntryMutationResult, type WorkbenchLanguageServiceFileEdit, type WorkbenchLanguageServiceNewFile, type WorkbenchReadFileResult, type WorkbenchSaveFileRequest, type WorkbenchSaveFileResult } from '@shared/contracts/workbench'

import { applyWorkbenchLanguageServiceEditsToContent } from './workbenchCodeMirrorLanguageService'
import { canEditWorkbenchFileContent, resolveWorkbenchEditorEditMode } from './workbenchEditorEditMode'

/** 语言服务的跨文件改动落不到某个文件的原因。 */
export type WorkbenchLanguageServiceFileChangeFailureReason =
  | 'read-only'
  | 'unsupported-text'
  | 'changed-on-disk'
  /** 算改动的工夫里，编辑器里的正文又变了，改动对不上了。 */
  | 'changed-in-editor'
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

export interface WorkbenchLanguageServiceFileCreationPorts {
  createEntry(
    request: Pick<WorkbenchCreateEntryRequest, 'parentPath' | 'name' | 'type'>
  ): Promise<Result<WorkbenchEntryMutationResult>>
  saveFile(request: Pick<WorkbenchSaveFileRequest, 'path' | 'content'>): Promise<Result<WorkbenchSaveFileResult>>
}

export interface WorkbenchLanguageServiceFileCreationResult {
  /** 建成了的文件。 */
  createdPaths: string[]
  /** 多了文件的目录：文件树要重读它们。 */
  parentPaths: string[]
  failures: WorkbenchLanguageServiceFileChangeFailure[]
}

/**
 * 语言服务要新建的文件（重构「移到新文件」）。与文件树里新建文件走同一条路：先建空文件（目标已存在就失败，
 * 不覆盖；主进程把它记为新文件），再经保存管线写入正文。一个没建成不挡住其余的，逐个返回原因。
 */
export async function createWorkbenchLanguageServiceFiles(
  files: readonly WorkbenchLanguageServiceNewFile[],
  ports: WorkbenchLanguageServiceFileCreationPorts
): Promise<WorkbenchLanguageServiceFileCreationResult> {
  const createdPaths: string[] = []
  const parentPaths = new Set<string>()
  const failures: WorkbenchLanguageServiceFileChangeFailure[] = []

  for (const file of files) {
    const separator = file.path.lastIndexOf('/')
    const created = await ports.createEntry({
      parentPath: separator < 0 ? '.' : file.path.slice(0, separator),
      name: file.path.slice(separator + 1),
      type: 'file',
    })
    if (!created.ok) {
      failures.push({ path: file.path, reason: 'error', message: created.error.message })
      continue
    }
    createdPaths.push(created.data.entry.path)
    parentPaths.add(created.data.parentPath)
    if (!file.content) continue

    const saved = await ports.saveFile({ path: created.data.entry.path, content: file.content })
    if (!saved.ok) failures.push({ path: file.path, reason: 'error', message: saved.error.message })
  }
  return { createdPaths, parentPaths: [...parentPaths], failures }
}
