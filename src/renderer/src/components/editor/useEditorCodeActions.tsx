import { type ReactElement, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { WorkbenchHostRuntime } from '@renderer/host'
import {
  buildWorkbenchCodeActionMenuRows,
  buildWorkbenchCodeMirrorChanges,
  collectWorkbenchDiagnosticsInRange,
  partitionWorkbenchCodeActionChanges,
  resolveWorkbenchCodeActionSupport,
  type WorkbenchCodeActionMenuRow,
  type WorkbenchLanguageServiceWorkspaceEditRequest,
  workbenchRangeFromOffsets,
} from '@renderer/models/editor/workbenchCodeActions'
import type {
  WorkbenchEditorHoverAction,
  WorkbenchEditorHoverCodeActions,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageFeatures'
import { buildWorkbenchLanguageServiceRequestBase } from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import type { WorkbenchEditorCommandId } from '@renderer/models/editor/workbenchEditorCommands'
import {
  getWorkbenchLanguageServiceCodeActions,
  resolveWorkbenchLanguageServiceCodeAction,
} from '@renderer/models/editor/workbenchLanguageServiceIpc'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceCodeAction,
  WorkbenchLanguageServiceEditFormat,
  WorkbenchLanguageServiceRange,
} from '@shared/contracts'

import { useLatest, useMemoizedFn } from '../../support/genericHooks'

import { EditorCodeActionMenu, type EditorCodeActionMenuAnchor } from './EditorCodeActionMenu'

/** 诊断浮层上最多列这么多个修复按钮；更多的在光标菜单里。 */
const MaxHoverActions = 6

/** 一次请求照着算的那份正文：结果回来、动作被选中时，编辑器还停在这份正文上才算数。 */
interface CodeActionSource {
  view: EditorView
  document: Text
  path: string
  content: string
  range: WorkbenchLanguageServiceRange
}

interface CodeActionMenuState {
  anchor: EditorCodeActionMenuAnchor
  source: CodeActionSource
  /** null：还在问。 */
  rows: Nullable<readonly WorkbenchCodeActionMenuRow[]>
  error: Nullable<string>
  busy: boolean
}

interface UseEditorCodeActionsOptions {
  viewRef: RefObject<Nullable<EditorView>>
  projectRoot: string
  path: Nullable<string>
  language: string
  /** 只读或禁用的编辑器：不给任何会改代码的动作。 */
  readOnly: boolean
  getOpenTabs: () => readonly WorkbenchOpenEditorTab[]
  getEditFormat: () => WorkbenchLanguageServiceEditFormat
  hostRuntime: WorkbenchHostRuntime
  /** 动作动到了别的文件、要新建文件：交给页面去落。 */
  onApplyWorkspaceEdit?: (request: WorkbenchLanguageServiceWorkspaceEditRequest) => void
}

export interface EditorCodeActions {
  /** 这个文件此刻能不能用某个命令（右键菜单据此置灰）。 */
  canRun: (command: WorkbenchEditorCommandId) => boolean
  run: (command: WorkbenchEditorCommandId) => void
  /** 诊断浮层要修复按钮时用。 */
  hover: WorkbenchEditorHoverCodeActions
  /** 光标菜单；没开着为 null。 */
  overlay: Nullable<ReactElement>
}

/**
 * 编辑器里的快速修复：光标菜单（⌥↩ / ⌘.、右键、命令面板）与诊断浮层上的按钮都从这里问语言服务、套改动。
 *
 * 每次请求记下当时的文档；结果回来时编辑器已经不在那份文档上（又打了字、换了文件）就作废。当前文件的改动由
 * 编辑器自己套（一步撤销），别的文件、要新建的文件交给页面。
 */
export function useEditorCodeActions({
  viewRef,
  projectRoot,
  path,
  language,
  readOnly,
  getOpenTabs,
  getEditFormat,
  hostRuntime,
  onApplyWorkspaceEdit,
}: UseEditorCodeActionsOptions): EditorCodeActions {
  const { t, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const latest = useLatest({
    projectRoot,
    path,
    language,
    readOnly,
    getOpenTabs,
    getEditFormat,
    hostRuntime,
    onApplyWorkspaceEdit,
  })
  const [menu, setMenu] = useState<Nullable<CodeActionMenuState>>(null)
  const menuGenerationRef = useRef(0)
  const support = useMemo(() => resolveWorkbenchCodeActionSupport(path), [path])

  const isCurrent = (source: CodeActionSource): boolean =>
    viewRef.current === source.view
    && source.view.state.doc === source.document
    && latest.current.path === source.path

  const captureSource = (view: EditorView, from: number, to: number): Nullable<CodeActionSource> => {
    const currentPath = latest.current.path
    if (!currentPath) return null
    return {
      view,
      document: view.state.doc,
      path: currentPath,
      content: view.state.doc.toString(),
      range: workbenchRangeFromOffsets(view.state, from, to),
    }
  }

  const requestBase = (source: CodeActionSource) => {
    const current = latest.current
    return {
      ...buildWorkbenchLanguageServiceRequestBase({
        projectRoot: current.projectRoot,
        path: source.path,
        language: current.language,
        content: source.content,
        openTabs: current.getOpenTabs(),
        format: current.getEditFormat(),
      }),
      range: source.range,
    }
  }

  const requestActions = (source: CodeActionSource, from: number, to: number) =>
    getWorkbenchLanguageServiceCodeActions(
      {
        ...requestBase(source),
        diagnostics: collectWorkbenchDiagnosticsInRange(source.view.state, from, to),
      },
      latest.current.hostRuntime
    )

  const canEdit = (view: EditorView): boolean => !latest.current.readOnly && !view.state.readOnly

  /**
   * 套上一个动作：要现算的先算，当前文件的自己改，别的文件与新文件交给页面。`stillWanted` 在等语言服务期间
   * 被问一次：用户已经收起了菜单就不再套。
   */
  const applyAction = useMemoizedFn(
    async (
      source: CodeActionSource,
      action: WorkbenchLanguageServiceCodeAction,
      stillWanted: () => boolean = () => true
    ): Promise<void> => {
      if (!canEdit(source.view) || !isCurrent(source)) return

      let changes = action.changes
      let createFiles = action.createFiles ?? []
      if (action.resolve) {
        const resolved = await resolveWorkbenchLanguageServiceCodeAction(
          { ...requestBase(source), resolve: action.resolve },
          latest.current.hostRuntime
        )
        if (!isCurrent(source) || !stillWanted()) return
        if (!resolved.ok) {
          messageLatest.current.error({
            title: tLatest.current('workbench.languageServiceActionFailed'),
            description: resolved.error.message,
          })
          return
        }
        changes = resolved.data.changes
        createFiles = resolved.data.createFiles
      }

      const { current, others } = partitionWorkbenchCodeActionChanges(source.path, changes)
      const editorChanges = buildWorkbenchCodeMirrorChanges(source.view.state, current)
      // 对不上当前正文的改动不套。
      if (!editorChanges) return

      const applyToEditor = (): Nullable<number> => {
        if (!isCurrent(source) || !canEdit(source.view)) return null
        if (isEmpty(editorChanges)) return 0
        source.view.dispatch({ changes: editorChanges, scrollIntoView: true })
        return 1
      }
      if (isEmpty(others) && isEmpty(createFiles)) {
        applyToEditor()
        return
      }
      latest.current.onApplyWorkspaceEdit?.({ changes: others, createFiles, applyToEditor })
    }
  )

  const closeMenu = useMemoizedFn((): void => {
    menuGenerationRef.current += 1
    setMenu(null)
    viewRef.current?.focus()
  })

  // 换了文件：菜单指着的是上一个文件里的位置，收起（在途的请求一并作废）。
  useEffect(() => {
    menuGenerationRef.current += 1
    setMenu(null)
  }, [path, projectRoot])

  /** 在光标处打开菜单：选区（没有选区就是光标）上的诊断有哪些修复。 */
  const openMenu = useMemoizedFn(async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !canEdit(view) || !resolveWorkbenchCodeActionSupport(latest.current.path).quickFix)
      return

    const selection = view.state.selection.main
    const source = captureSource(view, selection.from, selection.to)
    if (!source) return

    // 光标滚出了视野时拿不到坐标：菜单放在编辑区左上角，不因此不出来。
    const coords = view.coordsAtPos(selection.head)
    const editorRect = view.dom.getBoundingClientRect()
    const generation = ++menuGenerationRef.current
    setMenu({
      anchor: coords
        ? { left: coords.left, top: coords.top, bottom: coords.bottom }
        : { left: editorRect.left + 48, top: editorRect.top + 8, bottom: editorRect.top + 8 },
      source,
      rows: null,
      error: null,
      busy: false,
    })

    const result = await requestActions(source, selection.from, selection.to)
    if (generation !== menuGenerationRef.current) return
    if (!isCurrent(source)) {
      closeMenu()
      return
    }
    setMenu((current) =>
      current?.source === source
        ? {
            ...current,
            rows: result.ok ? buildWorkbenchCodeActionMenuRows(result.data.actions) : [],
            error: result.ok ? null : result.error.message,
          }
        : current
    )
  })

  const chooseAction = useMemoizedFn((action: WorkbenchLanguageServiceCodeAction): void => {
    if (!menu || menu.busy) return
    const { source } = menu
    const generation = menuGenerationRef.current
    const stillOpen = (): boolean => menuGenerationRef.current === generation
    setMenu({ ...menu, busy: true })
    void applyAction(source, action, stillOpen).finally(() => {
      // 这期间菜单已经被收起（或换成了新的一次）就不再动它。
      if (stillOpen()) closeMenu()
    })
  })

  const requestHoverActions = useMemoizedFn(
    async (view: EditorView, from: number, to: number): Promise<WorkbenchEditorHoverAction[]> => {
      if (!canEdit(view) || !resolveWorkbenchCodeActionSupport(latest.current.path).quickFix)
        return []
      const source = captureSource(view, from, to)
      if (!source) return []

      const result = await requestActions(source, from, to)
      if (!result.ok || !isCurrent(source)) return []
      return buildWorkbenchCodeActionMenuRows(result.data.actions)
        .flatMap((row) => (row.kind === 'action' ? [row.action] : []))
        .slice(0, MaxHoverActions)
        .map((action) => ({
          title: action.title,
          run: () => {
            void applyAction(source, action).finally(() => source.view.focus())
          },
        }))
    }
  )
  const hover = useMemo<WorkbenchEditorHoverCodeActions>(
    () => ({ request: requestHoverActions }),
    [requestHoverActions]
  )

  const canRun = (command: WorkbenchEditorCommandId): boolean => {
    switch (command) {
      case 'quick-fix':
        return !readOnly && support.quickFix
    }
  }

  const run = useMemoizedFn((command: WorkbenchEditorCommandId): void => {
    switch (command) {
      case 'quick-fix':
        void openMenu()
    }
  })

  return {
    canRun,
    run,
    hover,
    overlay: menu ? (
      <EditorCodeActionMenu
        anchor={menu.anchor}
        rows={menu.rows}
        error={menu.error}
        busy={menu.busy}
        label={t('workbench.editorCodeActionsTitle')}
        loadingLabel={t('workbench.editorCodeActionsLoading')}
        emptyLabel={t('workbench.editorCodeActionsEmpty')}
        onChoose={chooseAction}
        onClose={closeMenu}
      />
    ) : null,
  }
}
