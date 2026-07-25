import type { WorkbenchDirectoryEntry } from '@velaros/core/types'
import type { WorkbenchReadFileResult } from '@velaros/core/types'

export type TreeActionKind = 'create-file' | 'create-directory' | 'rename'

export interface PendingTreeAction {
  kind: TreeActionKind
  basePath: string
  entryPath?: string
  entryType?: WorkbenchDirectoryEntry['type']
}

export interface WorkbenchOpenEditorTab {
  path: string
  file: WorkbenchReadFileResult
  content: string
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
  sourceLabel?: LooseOptional<string>
  officePreview?: LooseOptional<WorkbenchOfficePreview>
}

export interface WorkbenchOpenEditorExternalChange {
  status: 'modified' | 'unavailable'
  detectedAt: number
  diskFile?: WorkbenchReadFileResult
  message?: string
}
