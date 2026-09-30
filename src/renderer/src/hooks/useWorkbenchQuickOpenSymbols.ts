import { useEffect, useRef, useState } from 'react'
import { useWorkbenchHostRuntime } from '@renderer/host'
import { buildWorkbenchLanguageServiceRequestBase } from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import { getWorkbenchLanguageServiceDocumentSymbols } from '@renderer/models/editor/workbenchLanguageServiceIpc'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import type { WorkbenchLanguageServiceDocumentSymbol } from '@shared/contracts'

import { useLatest } from '../support/genericHooks'

export interface WorkbenchQuickOpenSymbolsState {
  /** 当前文件的符号，按文件里的先后；语言服务还没答复（或这一模式没开着）时为 null。 */
  symbols: Nullable<readonly WorkbenchLanguageServiceDocumentSymbol[]>
  /** 这份符号是照哪个文件算的。 */
  path: Nullable<string>
}

const NoSymbols: WorkbenchQuickOpenSymbolsState = { symbols: null, path: null }

/**
 * 快速打开 `@` 模式要的符号：进到这个模式时按当前文件此刻的正文问一次语言服务（大纲是语法层面的，很快）。
 * 换了文件、正文变了就重问；答复回来时已经不是那个文件、那份正文了就不用。
 */
export function useWorkbenchQuickOpenSymbols({
  enabled,
  projectRoot,
  path,
  content,
  openTabs,
}: {
  enabled: boolean
  projectRoot: Nullable<string>
  path: Nullable<string>
  content: string
  openTabs: readonly WorkbenchOpenEditorTab[]
}): WorkbenchQuickOpenSymbolsState {
  const hostRuntime = useWorkbenchHostRuntime()
  const [state, setState] = useState<WorkbenchQuickOpenSymbolsState>(NoSymbols)
  const generationRef = useRef(0)
  const openTabsLatest = useLatest(openTabs)

  useEffect(() => {
    const generation = ++generationRef.current
    if (!enabled || !projectRoot || !path) {
      setState(NoSymbols)
      return
    }

    void (async () => {
      let symbols: readonly WorkbenchLanguageServiceDocumentSymbol[] = []
      try {
        const result = await getWorkbenchLanguageServiceDocumentSymbols(
          buildWorkbenchLanguageServiceRequestBase({
            projectRoot,
            path,
            language: fileLanguage(path),
            content,
            openTabs: openTabsLatest.current,
          }),
          hostRuntime
        )
        if (result.ok) symbols = result.data.symbols
      } catch {
        // arch-guard:silent-catch-ok 语言服务答不上来就当这个文件没有符号可列，面板照常能用。
      }
      if (generation === generationRef.current) setState({ symbols, path })
    })()
  }, [content, enabled, hostRuntime, openTabsLatest, path, projectRoot])

  // 换了文件而新的还没答复：旧文件的符号不能照着新文件的路径跳。
  return state.path === path ? state : NoSymbols
}
