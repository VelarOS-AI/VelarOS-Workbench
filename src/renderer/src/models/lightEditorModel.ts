import { toOptional } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import type { WorkbenchTextEncoding, WorkbenchTextEol } from '@shared/workbenchTextFormat'

import {
  readWorkbenchAppLocale,
  translateWorkbenchAppMessage,
} from '../i18n/useStandaloneWorkbenchLocalization'
import type { WorkbenchLightEditorTab } from '../types/workbenchTypes'

import type { WorkbenchProjectContextIndex } from './project/workbenchProjectContextIndex'

export const EMPTY_LIGHT_EDITOR_PROJECT_CONTEXT_INDEX: WorkbenchProjectContextIndex = {
  files: [],
  symbols: [],
  loadedDirectoryCount: 0,
  indexedFileCount: 0,
}

export async function saveLightEditorTab(
  tab: WorkbenchLightEditorTab,
  invoke: {
    saveWorkbenchFile: (request: {
      projectRoot: string
      path: string
      content: string
      encoding?: WorkbenchTextEncoding
      eol?: WorkbenchTextEol
      expectedModifiedAt?: number
      expectedSize?: number
    }) => Promise<Result<{ size: number; modifiedAt: number }>>
  }
): Promise<{ size: number; modifiedAt: number }> {
  if (tab.imagePreview || tab.textIssue)
    throw new AppError(
      'VALIDATION',
      translateWorkbenchAppMessage(readWorkbenchAppLocale(), 'workbench.previewNotSavableAsText')
    )

  const saved = Result.unwrap(
    await invoke.saveWorkbenchFile({
      projectRoot: tab.projectRoot,
      path: tab.path,
      content: tab.content,
      // 改动卡没有格式时，主进程沿用磁盘格式。
      encoding: toOptional(tab.encoding),
      eol: toOptional(tab.eol),
      expectedModifiedAt: tab.modifiedAt ?? undefined,
      expectedSize: tab.size,
    })
  )

  return {
    size: saved.size,
    modifiedAt: saved.modifiedAt,
  }
}
