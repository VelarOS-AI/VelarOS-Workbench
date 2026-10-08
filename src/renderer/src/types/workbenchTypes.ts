import { type WorkbenchDirectoryEntry, type WorkbenchImagePreview, type WorkbenchReadFileResult } from '@shared/contracts/workbench'
import type {
  WorkbenchTextEncoding,
  WorkbenchTextEol,
  WorkbenchTextFormat,
  WorkbenchTextIssue,
} from '@shared/workbenchTextFormat'

export type TreeActionKind = 'create-file' | 'create-directory' | 'rename'

export interface PendingTreeAction {
  kind: TreeActionKind
  basePath: string
  entryPath?: string
  entryType?: WorkbenchDirectoryEntry['type']
}

export interface WorkbenchOpenEditorTab {
  path: string
  /** 磁盘快照，含磁盘上的编码与换行符。 */
  file: WorkbenchReadFileResult
  /** 编辑缓冲：去掉 BOM、换行统一为 LF 的正文。 */
  content: string
  /**
   * 用户明确选的格式转换（转换为 UTF-8、换换行符），保存时按它写；保存成功前一直算未保存。
   * 没有时按 `file` 上的编码与换行符原样写回。
   */
  textConversion?: WorkbenchTextFormat
  /** 上一次保存被拒的说明：内容里有文件编码写不出的字符。内容一改就清掉，改之前不再自动保存。 */
  unencodableSaveError?: string
  externalChange?: WorkbenchOpenEditorExternalChange
}

export type WorkbenchOfficePreviewKind = 'docx' | 'pptx' | 'xlsx'

export interface WorkbenchOfficePreview {
  kind: WorkbenchOfficePreviewKind
  buffer: ArrayBuffer
}

export interface WorkbenchLightEditorTab {
  id: string
  projectRoot: string
  path: string
  content: string
  size: number
  modifiedAt: Nullable<number>
  totalLines: number
  truncated: boolean
  /** 从磁盘读出来的标签带着磁盘上的格式，保存时按它写回；改动卡里的正文没有，保存时沿用磁盘上的。 */
  encoding?: LooseOptional<WorkbenchTextEncoding>
  eol?: LooseOptional<WorkbenchTextEol>
  /** 磁盘字节写不回原样：只读。 */
  textIssue?: LooseOptional<WorkbenchTextIssue>
  sourceLabel?: LooseOptional<string>
  officePreview?: LooseOptional<WorkbenchOfficePreview>
  imagePreview?: LooseOptional<WorkbenchImagePreview>
}

export interface WorkbenchOpenEditorExternalChange {
  status: 'deleted' | 'modified' | 'unavailable'
  detectedAt: number
  diskFile?: WorkbenchReadFileResult
  message?: string
}
