import { lazy, type ReactElement, type RefObject, Suspense, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import type { WorkbenchHostRuntime } from '@renderer/host'
import {
  createWorkbenchCallHierarchy,
  failWorkbenchCallHierarchyNode,
  resolveWorkbenchCallHierarchyTarget,
  setWorkbenchCallHierarchyChildren,
  toggleWorkbenchCallHierarchyNode,
  type WorkbenchCallHierarchyNode,
  type WorkbenchCallHierarchyState,
} from '@renderer/models/editor/workbenchCallHierarchy'
import {
  buildWorkbenchLanguageServiceOpenFiles,
  buildWorkbenchLanguageServiceRequestBase,
  usesWorkbenchSemanticLanguageService,
  usesWorkbenchTypeScriptLanguageService,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import type { WorkbenchEditorNavigationCommandId } from '@renderer/models/editor/workbenchEditorCommands'
import {
  getWorkbenchLanguageServiceCallHierarchy,
  getWorkbenchLanguageServiceDefinition,
  getWorkbenchLanguageServiceReferences,
} from '@renderer/models/editor/workbenchLanguageServiceIpc'
import {
  buildWorkbenchSymbolLocationsRequest,
  type WorkbenchSymbolLocationsRequest,
} from '@renderer/models/editor/workbenchSymbolLocations'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchLanguageServiceCallHierarchyDirection,
  WorkbenchLanguageServiceCallHierarchyResult,
} from '@shared/contracts'

import { useLatest, useMemoizedFn } from '../../support/genericHooks'

// 调用层次面板用到的时候才加载：不进编辑器那一块。
const LazyEditorCallHierarchyPanel = lazy(async () => ({
  default: (await import('./EditorCallHierarchyPanel')).EditorCallHierarchyPanel,
}))

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
  /** 跳到一个位置（别的文件以预览标签打开）。 */
  onGoToLocation: (path: string, line: number, column: number) => void
}

export interface EditorSymbolNavigation {
  /** 这个文件此刻能不能用某个命令（右键菜单据此置灰）。 */
  canRun: (command: WorkbenchEditorNavigationCommandId) => boolean
  run: (command: WorkbenchEditorNavigationCommandId) => void
  /** 调用层次面板；没开着为 null。画在编辑器的容器里。 */
  overlay: Nullable<ReactElement>
}

/**
 * 编辑器里跟着光标处的符号走的导航：查找引用、调用层次。不改代码，只读的文件也能用。
 *
 * 每次请求记下当时的文档；答复回来时编辑器已经不在那份文档上（又打了字、换了文件），或者又发起了新的一次，
 * 这份答复作废。调用层次面板开出来之后归它自己管：换文件、接着打字它都留着，直到关掉。
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
  onGoToLocation,
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
    onGoToLocation,
  })
  const generationRef = useRef(0)
  const [callHierarchy, setCallHierarchy] = useState<Nullable<WorkbenchCallHierarchyState>>(null)
  /** 面板每开一次、每换一次方向加一：之前那棵树的答复回来就不用了。 */
  const callHierarchyGenerationRef = useRef(0)
  /** 眼下这棵树是第几棵：换一棵面板就重新挂一次，键盘焦点回到根上。 */
  const [callHierarchyTree, setCallHierarchyTree] = useState(0)

  /** 光标处标识符的位置与那一刻的请求。 */
  const requestAtCursor = () => {
    const view = viewRef.current
    const { path: currentPath, projectRoot: root } = latest.current
    const identifier = latest.current.getIdentifier()
    if (!view || !currentPath || !identifier) return null

    const document = view.state.doc
    const line = document.lineAt(identifier.from)
    const position = {
      line: line.number,
      column: identifier.from - line.from + 1,
      offset: identifier.from,
    }
    return {
      view,
      document,
      identifier,
      path: currentPath,
      position,
      request: {
        ...buildWorkbenchLanguageServiceRequestBase({
          projectRoot: root,
          path: currentPath,
          language: latest.current.language,
          content: document.toString(),
          openTabs: latest.current.getOpenTabs(),
        }),
        position,
      },
    }
  }

  /** 光标处符号的全部引用（连同定义），列进定义 / 引用面板；键盘焦点放进列表。 */
  const findReferences = useMemoizedFn(async (): Promise<void> => {
    const source = requestAtCursor()
    if (!source) return
    const { view, document, identifier, path: currentPath, position, request } = source
    const runtime = latest.current.hostRuntime

    const generation = ++generationRef.current
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

  /**
   * 问一个函数的一层调用关系。`item` 是它名字的位置；正文取编辑器里此刻的（眼前这个文件、别的开着的标签），
   * 没开着的文件由语言服务读盘。
   */
  const requestCalls = async (
    item: { path: string; line: number; column: number },
    direction: WorkbenchLanguageServiceCallHierarchyDirection
  ): Promise<WorkbenchLanguageServiceCallHierarchyResult> => {
    const { projectRoot: root, path: currentPath, getOpenTabs: openTabs, hostRuntime: runtime } =
      latest.current
    const tabs = openTabs()
    const content =
      item.path === currentPath && viewRef.current
        ? viewRef.current.state.doc.toString()
        : tabs.find((tab) => tab.path === item.path)?.content
    const result = await getWorkbenchLanguageServiceCallHierarchy(
      {
        projectRoot: root,
        path: item.path,
        language: fileLanguage(item.path),
        content,
        openFiles: buildWorkbenchLanguageServiceOpenFiles(tabs),
        position: { line: item.line, column: item.column },
        direction,
      },
      runtime
    )
    if (!result.ok) throw result.error
    return result.data
  }

  /** 给树上的一个节点问下一层，答复回来挂上去；这棵树已经换掉了就不挂。 */
  const loadCalls = (
    nodeId: string,
    item: { path: string; line: number; column: number },
    direction: WorkbenchLanguageServiceCallHierarchyDirection,
    generation: number
  ): void => {
    const settle = (
      update: (state: WorkbenchCallHierarchyState) => WorkbenchCallHierarchyState
    ): void => {
      if (generation !== callHierarchyGenerationRef.current) return
      setCallHierarchy((state) => (state ? update(state) : state))
    }
    requestCalls(item, direction).then(
      (result) =>
        settle((state) =>
          // 那个位置上已经不是函数了（文件在这期间改过）：当作问不到。
          result.item
            ? setWorkbenchCallHierarchyChildren(state, nodeId, result.calls)
            : failWorkbenchCallHierarchyNode(
                state,
                nodeId,
                tLatest.current('workbench.editorCallHierarchyStale')
              )
        ),
      (error: unknown) =>
        settle((state) => failWorkbenchCallHierarchyNode(state, nodeId, AppError.from(error).message))
    )
  }

  /** 以这个函数为根开一棵树（或换个方向重开），第一层马上去问。 */
  const showCallHierarchy = (
    item: WorkbenchCallHierarchyNode['item'],
    direction: WorkbenchLanguageServiceCallHierarchyDirection,
    calls?: WorkbenchLanguageServiceCallHierarchyResult['calls']
  ): void => {
    const generation = ++callHierarchyGenerationRef.current
    setCallHierarchyTree(generation)
    const state = createWorkbenchCallHierarchy(item, direction)
    if (calls) {
      setCallHierarchy(setWorkbenchCallHierarchyChildren(state, state.rootId, calls))
      return
    }
    setCallHierarchy(state)
    loadCalls(state.rootId, item, direction, generation)
  }

  /** 光标处函数的调用层次：先看谁调用它。 */
  const openCallHierarchy = useMemoizedFn(async (): Promise<void> => {
    const source = requestAtCursor()
    if (!source) return
    const { view, document, path: currentPath, position } = source

    const generation = ++generationRef.current
    const result = await requestCalls({ path: currentPath, ...position }, 'incoming')
    if (
      generation !== generationRef.current
      || viewRef.current !== view
      || view.state.doc !== document
      || latest.current.path !== currentPath
    ) return

    if (!result.item) {
      messageLatest.current.info({ title: tLatest.current('workbench.editorCallHierarchyNone') })
      return
    }
    showCallHierarchy(result.item, 'incoming', result.calls)
  })

  const toggleCallHierarchyNode = useMemoizedFn((nodeId: string): void => {
    if (!callHierarchy) return
    const { state, load } = toggleWorkbenchCallHierarchyNode(callHierarchy, nodeId)
    setCallHierarchy(state)
    const node = state.nodes.get(nodeId)
    if (load && node)
      loadCalls(nodeId, node.item, state.direction, callHierarchyGenerationRef.current)
  })

  const changeCallHierarchyDirection = useMemoizedFn(
    (direction: WorkbenchLanguageServiceCallHierarchyDirection): void => {
      const root = callHierarchy?.nodes.get(callHierarchy.rootId)
      if (!callHierarchy || !root || callHierarchy.direction === direction) return
      showCallHierarchy(root.item, direction)
    }
  )

  const navigateCallHierarchyNode = useMemoizedFn((node: WorkbenchCallHierarchyNode): void => {
    if (!callHierarchy) return
    const target = resolveWorkbenchCallHierarchyTarget(callHierarchy, node)
    latest.current.onGoToLocation(target.path, target.line, target.column)
  })

  const closeCallHierarchy = useMemoizedFn((): void => {
    callHierarchyGenerationRef.current += 1
    setCallHierarchy(null)
  })

  const canRun = (command: WorkbenchEditorNavigationCommandId): boolean => {
    switch (command) {
      case 'find-references':
        return usesWorkbenchSemanticLanguageService(path)
      // 调用层次是内置 TypeScript 服务给的。
      case 'call-hierarchy':
        return usesWorkbenchTypeScriptLanguageService(path)
    }
  }

  const run = useMemoizedFn((command: WorkbenchEditorNavigationCommandId): void => {
    if (!canRun(command)) return
    const failed = (titleKey: string) => (error: unknown) => {
      messageLatest.current.warning({
        title: tLatest.current(titleKey),
        description: AppError.from(error).message,
      })
    }
    switch (command) {
      case 'find-references':
        findReferences().catch(failed('workbench.editorReferencesFailed'))
        break
      case 'call-hierarchy':
        openCallHierarchy().catch(failed('workbench.editorCallHierarchyFailed'))
        break
    }
  })

  return {
    canRun,
    run,
    overlay: callHierarchy ? (
      <Suspense fallback={null}>
        <LazyEditorCallHierarchyPanel
          key={callHierarchyTree}
          projectRoot={projectRoot}
          state={callHierarchy}
          onToggle={toggleCallHierarchyNode}
          onNavigate={navigateCallHierarchyNode}
          onDirectionChange={changeCallHierarchyDirection}
          onClose={closeCallHierarchy}
          onFocusEditor={() => viewRef.current?.focus()}
        />
      </Suspense>
    ) : null,
  }
}
