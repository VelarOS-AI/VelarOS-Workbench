import { type RefObject, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import type { WorkbenchHostRuntime } from '@renderer/host'
import {
  buildWorkbenchLanguageServiceRequestBase,
  usesWorkbenchSemanticLanguageService,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import type { WorkbenchEditorNavigationCommandId } from '@renderer/models/editor/workbenchEditorCommands'
import {
  getWorkbenchLanguageServiceDefinition,
  getWorkbenchLanguageServiceReferences,
} from '@renderer/models/editor/workbenchLanguageServiceIpc'
import {
  buildWorkbenchSymbolLocationsRequest,
  type WorkbenchSymbolLocationsRequest,
} from '@renderer/models/editor/workbenchSymbolLocations'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { useLatest, useMemoizedFn } from '../../support/genericHooks'

interface UseEditorSymbolNavigationOptions {
  viewRef: RefObject<Nullable<EditorView>>
  projectRoot: string
  path: Nullable<string>
  language: string
  getOpenTabs: () => readonly WorkbenchOpenEditorTab[]
  hostRuntime: WorkbenchHostRuntime
  /** 光标所在的标识符；不在标识符上为 null。 */
  getIdentifier: () => Nullable<{ text: string; from: number }>
  onOpenSymbolLocations?: (request: WorkbenchSymbolLocationsRequest, visible?: boolean) => void
}

export interface EditorSymbolNavigation {
  /** 这个文件此刻能不能用某个命令（右键菜单据此置灰）。 */
  canRun: (command: WorkbenchEditorNavigationCommandId) => boolean
  run: (command: WorkbenchEditorNavigationCommandId) => void
}

/**
 * 编辑器里跟着光标处的符号走的导航（查找引用）。不改代码，只读的文件也能用。
 *
 * 每次请求记下当时的文档；答复回来时编辑器已经不在那份文档上（又打了字、换了文件），或者又发起了新的一次，
 * 这份答复作废。
 */
export function useEditorSymbolNavigation({
  viewRef,
  projectRoot,
  path,
  language,
  getOpenTabs,
  hostRuntime,
  getIdentifier,
  onOpenSymbolLocations,
}: UseEditorSymbolNavigationOptions): EditorSymbolNavigation {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const latest = useLatest({
    projectRoot,
    path,
    language,
    getOpenTabs,
    hostRuntime,
    getIdentifier,
    onOpenSymbolLocations,
  })
  const generationRef = useRef(0)

  /** 光标处符号的全部引用（连同定义），列进定义 / 引用面板；键盘焦点放进列表。 */
  const findReferences = useMemoizedFn(async (): Promise<void> => {
    const view = viewRef.current
    const { path: currentPath, projectRoot: root, hostRuntime: runtime } = latest.current
    const identifier = latest.current.getIdentifier()
    if (!view || !currentPath || !identifier) return

    const generation = ++generationRef.current
    const document = view.state.doc
    const line = document.lineAt(identifier.from)
    const position = {
      line: line.number,
      column: identifier.from - line.from + 1,
      offset: identifier.from,
    }
    const request = {
      ...buildWorkbenchLanguageServiceRequestBase({
        projectRoot: root,
        path: currentPath,
        language: latest.current.language,
        content: document.toString(),
        openTabs: latest.current.getOpenTabs(),
      }),
      position,
    }
    // 定义只用来给列表里的那一行打上「定义」的标记，问不到也照列引用。
    const [references, definitions] = await Promise.all([
      getWorkbenchLanguageServiceReferences(request, runtime),
      getWorkbenchLanguageServiceDefinition(request, runtime).catch(() => null),
    ])
    if (
      generation !== generationRef.current
      || viewRef.current !== view
      || view.state.doc !== document
      || latest.current.path !== currentPath
    ) return

    if (!references.ok) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.editorReferencesFailed'),
        description: references.error.message,
      })
      return
    }
    if (isEmpty(references.data.locations)) {
      messageLatest.current.info({ title: tLatest.current('workbench.editorReferencesEmpty') })
      return
    }

    latest.current.onOpenSymbolLocations?.(
      buildWorkbenchSymbolLocationsRequest({
        symbol: identifier.text,
        origin: { path: currentPath, line: position.line, column: position.column },
        definitions: definitions?.ok ? definitions.data.locations : [],
        references: references.data.locations,
        focusList: true,
      }),
      true
    )
  })

  const canRun = (command: WorkbenchEditorNavigationCommandId): boolean => {
    switch (command) {
      case 'find-references':
        return usesWorkbenchSemanticLanguageService(path)
    }
  }

  const run = useMemoizedFn((command: WorkbenchEditorNavigationCommandId): void => {
    if (!canRun(command)) return
    switch (command) {
      case 'find-references':
        findReferences().catch((error: unknown) => {
          messageLatest.current.warning({
            title: tLatest.current('workbench.editorReferencesFailed'),
            description: AppError.from(error).message,
          })
        })
        break
    }
  })

  return { canRun, run }
}
