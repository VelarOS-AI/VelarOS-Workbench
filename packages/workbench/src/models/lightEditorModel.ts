import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
import type { SystemLocalAttachmentFileResult } from '@velaros-ai/core/types'

import type {
  WorkbenchLightEditorTab,
  WorkbenchOfficePreviewKind,
} from '../types/workbenchTypes'

import type { WorkbenchProjectContextIndex } from './project/workbenchProjectContextIndex'

export const LIGHT_EDITOR_SESSION_ID = 'light-window'
export const LIGHT_EDITOR_MAX_CHARS = 300_000

export const EMPTY_LIGHT_EDITOR_PROJECT_CONTEXT_INDEX: WorkbenchProjectContextIndex = {
  files: [],
  symbols: [],
  loadedDirectoryCount: 0,
  indexedFileCount: 0,
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).findLast((value) => !!value) ?? path
}

export function parentPathFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index > 0 ? normalized.slice(0, index) : ''
}

export function isWorkbenchEmbeddedLightTab(tab: WorkbenchLightEditorTab): boolean {
  return tab.id.includes('\0')
}

export function resolveLightEditorLanguagePath(tab: WorkbenchLightEditorTab): string {
  return tab.sourceLabel ?? tab.path
}

export function resolveLightEditorSaveTarget(tab: WorkbenchLightEditorTab): {
  mode: 'workbench' | 'absolute'
  projectRoot: string
  path: string
} {
  if (isWorkbenchEmbeddedLightTab(tab)) return {
      mode: 'workbench',
      projectRoot: tab.projectRoot,
      path: tab.path,
    }

  return {
    mode: 'absolute',
    projectRoot: tab.projectRoot,
    path: tab.sourceLabel ?? tab.id,
  }
}

function countLines(content: string): number {
  return content ? content.split('\n').length : 1
}

const OFFICE_PREVIEW_EXTENSIONS: Readonly<Record<string, WorkbenchOfficePreviewKind>> = {
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
}

export function resolveOfficePreviewKind(
  path: string,
  mediaType = ''
): Nullable<WorkbenchOfficePreviewKind> {
  const extension = fileNameFromPath(path).split('.').at(-1)?.toLowerCase() ?? ''
  const extensionKind = OFFICE_PREVIEW_EXTENSIONS[extension]
  if (extensionKind) return extensionKind

  const normalizedMediaType = mediaType.toLowerCase()
  if (normalizedMediaType.includes('wordprocessingml')) return 'docx'
  if (normalizedMediaType.includes('spreadsheetml')) return 'xlsx'
  if (normalizedMediaType.includes('presentationml')) return 'pptx'

  return null
}

function copyFileBuffer(data: Uint8Array): ArrayBuffer {
  return new Uint8Array(data).buffer
}

export function decodeFileContent(file: SystemLocalAttachmentFileResult): {
  content: string
  totalLines: number
  truncated: boolean
} {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(file.data)
  const truncated = decoded.length > LIGHT_EDITOR_MAX_CHARS
  const content = truncated ? decoded.slice(0, LIGHT_EDITOR_MAX_CHARS) : decoded

  return {
    content,
    totalLines: countLines(decoded),
    truncated,
  }
}

export function buildLightEditorTab(file: SystemLocalAttachmentFileResult): WorkbenchLightEditorTab {
  const officePreviewKind = resolveOfficePreviewKind(file.path, file.mediaType)
  if (officePreviewKind)
    return {
      id: file.path,
      projectRoot: parentPathFromPath(file.path),
      path: fileNameFromPath(file.path),
      content: '',
      size: file.size,
      modifiedAt: file.lastModified,
      totalLines: 1,
      truncated: false,
      sourceLabel: file.path,
      officePreview: {
        kind: officePreviewKind,
        buffer: copyFileBuffer(file.data),
      },
    }

  const decoded = decodeFileContent(file)

  return {
    id: file.path,
    projectRoot: parentPathFromPath(file.path),
    path: fileNameFromPath(file.path),
    content: decoded.content,
    size: file.size,
    modifiedAt: file.lastModified,
    totalLines: decoded.totalLines,
    truncated: decoded.truncated,
    sourceLabel: file.path,
  }
}

export async function saveLightEditorTab(
  tab: WorkbenchLightEditorTab,
  invoke: {
    saveWorkbenchFile: (request: {
      projectRoot: string
      path: string
      content: string
      expectedModifiedAt?: number
      expectedSize?: number
    }) => Promise<Result<{ size: number; modifiedAt: number }>>
    writeLocalAttachmentFile: (request: {
      sessionId: string
      path: string
      content: string
      expectedLastModified?: number
      expectedSize?: number
    }) => Promise<Result<{ size: number; lastModified: number }>>
  }
): Promise<{ size: number; modifiedAt: number }> {
  if (tab.officePreview)
    throw new AppError('VALIDATION', 'Office 预览为只读内容，不能作为纯文本保存。')

  const target = resolveLightEditorSaveTarget(tab)

  if (target.mode === 'workbench') {
    const saved = Result.unwrap(
      await invoke.saveWorkbenchFile({
        projectRoot: target.projectRoot,
        path: target.path,
        content: tab.content,
        expectedModifiedAt: tab.modifiedAt ?? undefined,
        expectedSize: tab.size,
      })
    )

    return {
      size: saved.size,
      modifiedAt: saved.modifiedAt,
    }
  }

  const saved = Result.unwrap(
    await invoke.writeLocalAttachmentFile({
      sessionId: LIGHT_EDITOR_SESSION_ID,
      path: target.path,
      content: tab.content,
      expectedLastModified: tab.modifiedAt ?? undefined,
      expectedSize: tab.size,
    })
  )

  return {
    size: saved.size,
    modifiedAt: saved.lastModified,
  }
}
