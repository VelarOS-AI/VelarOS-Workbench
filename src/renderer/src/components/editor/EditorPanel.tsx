import {
  lazy,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { PackageManagerCommand } from '@renderer/models/commands/workbenchPackageScriptCommand'
import { inferWorkbenchPackageManagerForPackageJsonPath } from '@renderer/models/commands/workbenchPackageScriptCommand'
import {
  buildWorkbenchDiagnosticProblemId,
  findWorkbenchDiagnosticIndexAtPosition,
  resolveWorkbenchDiagnosticNavigationIndex,
  sortWorkbenchFileDiagnostics,
} from '@renderer/models/editor/workbenchCodeInsightModel'
import {
  buildWorkbenchEditorFindMatches,
  getWorkbenchEditorLineCount,
  parseWorkbenchGoToLineInput,
} from '@renderer/models/editor/workbenchEditorModel'
import {
  isSameWorkbenchGitChangeItem,
  type WorkbenchGitChangeItem,
  type WorkbenchGitDecorationMap,
} from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'
import type { WorkbenchLightEditorTab } from '@renderer/types/workbenchTypes'

import { isPresent,Log, toNullable } from '@velaros-ai/core'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'

import type {
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceFileEdit,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useLatest, useTimerScope } from '../../support/genericHooks'
import { useDismissOnWindowInteract } from '../../support/useDismissOnWindowInteract'
import type {
  WorkbenchEditorProjectBundle,
  WorkbenchEditorSurfaceBundle,
} from '../../types/workbenchSurfaceBundles'
import { type TopToolbarProps } from '../chrome/TopToolbar'
import { WorkbenchTopBar } from '../chrome/WorkbenchTopBar'
import { GitDiffEditorPanel } from '../git/GitDiffEditorPanel'

import type { EditorNavigationRequest } from './CodeInsightPanel'
import type {
  CodeMirrorEditor as CodeMirrorEditorComponent,
  CodeMirrorEditorHandle,
} from './CodeMirrorEditor'
import { EditorFileDiagnosticSummary } from './EditorFileDiagnosticSummary'
import { EditorFindBar } from './EditorFindBar'
import { EditorGoToLineBar } from './EditorGoToLineBar'
import {
  EditorTabBar,
  type WorkbenchEditorAuxiliaryTabItem,
} from './EditorTabBar'
import { type FileHistoryMode,FileHistoryView } from './FileHistoryView'
import { WorkbenchChatChangePreviewPanel } from './WorkbenchChatChangePreviewPanel'
import { WorkbenchLightFilePanel } from './WorkbenchLightFilePanel'

interface CodeMirrorEditorModule {
  CodeMirrorEditor: typeof CodeMirrorEditorComponent
}

let codeMirrorEditorModulePromise: Nullable<Promise<CodeMirrorEditorModule>> = null

function loadCodeMirrorEditorModule(): Promise<CodeMirrorEditorModule> {
  codeMirrorEditorModulePromise ??=
    import('./CodeMirrorEditor').catch((error) => {
      codeMirrorEditorModulePromise = null
      throw error
    })
  return codeMirrorEditorModulePromise
}

const LazyCodeMirrorEditor = lazy(async () => {
  const module = await loadCodeMirrorEditorModule()

  return { default: module.CodeMirrorEditor }
})

export interface WorkbenchEditorPanelTabsProps {
  onSelectOpenFile: (path: string) => void
  onCloseOpenFile: (path: string) => void
  onCloseOtherOpenFiles: (path: string) => void
  onCloseAllOpenFiles: () => void
  onCloseUnmodifiedOpenFiles: () => void
  onReorderOpenTabs: (fromPath: string, toPath: string) => void
}

export interface WorkbenchEditorPanelAuxiliaryTab extends WorkbenchEditorAuxiliaryTabItem {
  content: ReactNode
}

export interface WorkbenchEditorPanelDiffProps {
  diffWorkspaceRoot: string
  activeDiffItem?: LooseOptional<WorkbenchGitChangeItem>
  chatChangePreview?: LooseOptional<{
    items: WorkbenchGitChangeItem[]
    pendingFileAction: Nullable<string>
    onClose: () => void
    onDiscardItem: (item: WorkbenchGitChangeItem) => void
    onOpenFile: (path: string) => void
    onSelectItem: (item: WorkbenchGitChangeItem) => void
  }>
  auxiliaryTabs?: WorkbenchEditorPanelAuxiliaryTab[]
  /**
   * 调试 webview 常驻层：所有打开的调试选项卡的 webview 一直挂载在编辑区里，
   * 由该层内部按激活态切换可见性，从而切走再切回不丢页面状态。
   */
  debugTabsLayer?: ReactNode
  lightTab?: LooseOptional<{
    item: WorkbenchLightEditorTab
    onClose: () => void
    onSelect: () => void
    onContentChange: (content: string) => void
    onSave: () => void
    readOnly?: boolean
  }>
  onCloseDiffTab?: () => void
}

export interface WorkbenchEditorPanelWorkspaceProps {
  onRevertSelectedFile: () => void
  onSaveSelectedFile: () => void
  onSaveAllOpenFiles: () => void
  onResolveExternalFileConflict: (resolution: 'external' | 'local') => void
  onEditorContentChange: (content: string) => void
  onOpenDirectory: (path: string) => void
  onRevealSelectedFile: () => void
  onGoToDefinition: (path: string, line: number, column?: number) => void
  onApplyLanguageServiceFileChanges?: (changes: WorkbenchLanguageServiceFileEdit[]) => void
  packageManager: PackageManagerCommand
  onRunPackageScript: (command: string) => void
  onOpenQuickOpen: () => void
  onToggleGitTool: () => void
  onToggleProblems: () => void
  onCursorPositionChange?: (position: {
    line: number
    column: number
    selection?: {
      startLine: number
      endLine: number
      startColumn: number
      endColumn: number
    }
  }) => void
  onActiveProblemIdChange?: (problemId: Nullable<string>) => void
  navigationRequest?: LooseOptional<EditorNavigationRequest>
}

interface EditorPanelProps {
  chrome: TopToolbarProps
  showTopBar?: boolean
  workbenchTheme: WorkbenchThemeId
  workbenchProject: WorkbenchEditorProjectBundle
  workbenchEditor: WorkbenchEditorSurfaceBundle
  gitDecorations: WorkbenchGitDecorationMap
  selectedFileDiagnostics?: readonly WorkbenchLanguageServiceDiagnostic[]
  isSelectedFileDiagnosticsPending?: boolean
  tabs: WorkbenchEditorPanelTabsProps
  diff: WorkbenchEditorPanelDiffProps
  workspace: WorkbenchEditorPanelWorkspaceProps
}

export function EditorPanel({
  chrome,
  showTopBar = true,
  workbenchTheme,
  workbenchProject,
  workbenchEditor,
  gitDecorations,
  selectedFileDiagnostics = [],
  tabs: {
    onSelectOpenFile,
    onCloseOpenFile,
    onCloseOtherOpenFiles,
    onCloseAllOpenFiles,
    onCloseUnmodifiedOpenFiles,
    onReorderOpenTabs,
  },
  diff: {
    activeDiffItem = null,
    chatChangePreview = null,
    auxiliaryTabs = [],
    debugTabsLayer = null,
    lightTab = null,
    onCloseDiffTab,
  },
  workspace: {
    onSaveSelectedFile,
    onSaveAllOpenFiles,
    onResolveExternalFileConflict,
    onEditorContentChange,
    onGoToDefinition,
    onApplyLanguageServiceFileChanges,
    packageManager,
    onRunPackageScript,
    onToggleProblems,
    onCursorPositionChange,
    onActiveProblemIdChange,
    navigationRequest = null,
  },
}: EditorPanelProps): ReactElement {
  const { rootPath: projectRoot } = workbenchProject
  const {
    selectedFilePath,
    selectedFile,
    editorContent,
    openTabs,
    hasUnsavedChanges,
    canEditSelectedFile,
    projectContextIndex,
    isSavingFile,
  } = workbenchEditor
  const { t } = useWorkbenchI18n()
  const onCursorPositionLatest = useLatest(onCursorPositionChange)
  const editorRef = useRef<CodeMirrorEditorHandle>(null)
  const appliedNavigationRequestIdRef = useRef<Nullable<number>>(null)
  const [isFindOpen, setIsFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [activeFindIndex, setActiveFindIndex] = useState(0)
  const [hasActiveFindSelection, setHasActiveFindSelection] = useState(false)
  const [isGoToLineOpen, setIsGoToLineOpen] = useState(false)
  const timers = useTimerScope('EditorPanel')
  const [goToLineInput, setGoToLineInput] = useState('')
  const [externalConflictDialogOpen, setExternalConflictDialogOpen] = useState(false)
  const [fileHistoryMode, setFileHistoryMode] = useState<Nullable<FileHistoryMode>>(null)
  const [dismissedExternalConflictKey, setDismissedExternalConflictKey] =
    useState<Nullable<string>>(null)
  const [tabContextMenu, setTabContextMenu] = useState<
    Nullable<{
      path: string
      x: number
      y: number
    }>
  >(null)
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 })
  const [activeDiagnosticIndex, setActiveDiagnosticIndex] = useState(-1)
  const onActiveProblemIdChangeLatest = useLatest(onActiveProblemIdChange)
  const lastSyncedProblemIdRef = useRef<Nullable<string>>(null)

  // 编辑器 chunk 较大：让空闲期预热承担解析成本；若用户立刻点文件，lazy 仍会立即复用同一请求。
  useEffect(() => {
    if (selectedFile || !window.requestIdleCallback) return undefined

    const handle = window.requestIdleCallback(() => {
      void loadCodeMirrorEditorModule().catch((error) => {
        Log.tag('workbench-editor-panel').debug('空闲期预热编辑器失败', { error })
      })
    })
    return () => window.cancelIdleCallback(handle)
  }, [selectedFile])

  const selectedLanguage = selectedFile ? fileLanguage(selectedFile.path) : ''
  const selectedPackageManager = useMemo(
    () =>
      selectedFilePath
        ? inferWorkbenchPackageManagerForPackageJsonPath(
            selectedFilePath,
            projectContextIndex.files,
            packageManager
          )
        : packageManager,
    [packageManager, projectContextIndex.files, selectedFilePath]
  )
  const editorLineCount = useMemo(() => getWorkbenchEditorLineCount(editorContent), [editorContent])
  const findMatches = useMemo(
    () => buildWorkbenchEditorFindMatches(editorContent, findQuery),
    [editorContent, findQuery]
  )
  const sortedFileDiagnostics = useMemo(
    () => sortWorkbenchFileDiagnostics(selectedFileDiagnostics),
    [selectedFileDiagnostics]
  )
  const applyDiagnosticSelection = useCallback(
    (index: number, problemId: Nullable<string>) => {
      setActiveDiagnosticIndex((current) => (current === index ? current : index))
      if (lastSyncedProblemIdRef.current === problemId) return

      lastSyncedProblemIdRef.current = problemId
      onActiveProblemIdChangeLatest.current?.(problemId)
    },
    [onActiveProblemIdChangeLatest]
  )
  const clearDiagnosticSelection = useCallback(() => {
    applyDiagnosticSelection(-1, null)
  }, [applyDiagnosticSelection])
  const syncDiagnosticSelectionFromCursor = useCallback(
    (line: number, column: number) => {
      if (!sortedFileDiagnostics.length) {
        clearDiagnosticSelection()
        return
      }

      const indexAtCursor = findWorkbenchDiagnosticIndexAtPosition(
        sortedFileDiagnostics,
        line,
        column
      )
      if (indexAtCursor < 0) return

      const problemId = selectedFilePath
        ? buildWorkbenchDiagnosticProblemId(selectedFilePath, sortedFileDiagnostics[indexAtCursor])
        : null
      applyDiagnosticSelection(indexAtCursor, problemId)
    },
    [applyDiagnosticSelection, clearDiagnosticSelection, selectedFilePath, sortedFileDiagnostics]
  )
  useEffect(() => {
    lastSyncedProblemIdRef.current = null
    setCursorPosition((current) =>
      current.line === 1 && current.column === 1 ? current : { line: 1, column: 1 }
    )
    setActiveDiagnosticIndex((current) => (current === -1 ? current : -1))
    onActiveProblemIdChangeLatest.current?.(null)
  }, [onActiveProblemIdChangeLatest, selectedFilePath])
  const handleCursorPositionChange = useCallback<
    NonNullable<WorkbenchEditorPanelWorkspaceProps['onCursorPositionChange']>
  >(
    (position) => {
      setCursorPosition((current) =>
        current.line === position.line && current.column === position.column
          ? current
          : { line: position.line, column: position.column }
      )
      onCursorPositionChange?.(position)
    },
    [onCursorPositionChange]
  )
  useEffect(() => {
    syncDiagnosticSelectionFromCursor(cursorPosition.line, cursorPosition.column)
  }, [
    cursorPosition.column,
    cursorPosition.line,
    sortedFileDiagnostics,
    syncDiagnosticSelectionFromCursor,
  ])
  const navigateToDiagnostic = useCallback(
    (direction: 'next' | 'previous') => {
      if (!sortedFileDiagnostics.length) return

      const nextIndex = resolveWorkbenchDiagnosticNavigationIndex({
        diagnostics: sortedFileDiagnostics,
        activeIndex: activeDiagnosticIndex,
        line: cursorPosition.line,
        column: cursorPosition.column,
        direction,
      })
      if (nextIndex < 0) return

      const diagnostic = sortedFileDiagnostics[nextIndex]
      const problemId = selectedFilePath
        ? buildWorkbenchDiagnosticProblemId(selectedFilePath, diagnostic)
        : null
      applyDiagnosticSelection(nextIndex, problemId)
      editorRef.current?.moveToLine(diagnostic.range.startLine, diagnostic.range.startColumn)
      onCursorPositionLatest.current?.({
        line: diagnostic.range.startLine,
        column: diagnostic.range.startColumn,
      })
    },
    [
      activeDiagnosticIndex,
      applyDiagnosticSelection,
      cursorPosition.column,
      cursorPosition.line,
      onCursorPositionLatest,
      selectedFilePath,
      sortedFileDiagnostics,
    ]
  )
  const goToLineTarget = useMemo(
    () => parseWorkbenchGoToLineInput(goToLineInput, editorLineCount),
    [editorLineCount, goToLineInput]
  )
  const dirtyTabCount = useMemo(
    () => openTabs.filter((tab) => tab.content !== tab.file.content).length,
    [openTabs]
  )
  const selectedExternalChange = useMemo(
    () => toNullable(openTabs.find((tab) => tab.path === selectedFilePath)?.externalChange),
    [openTabs, selectedFilePath]
  )
  const activeAuxiliaryTab = useMemo(
    () => toNullable(auxiliaryTabs.find((tab) => tab.active)),
    [auxiliaryTabs]
  )
  const hasEditorOverlayTab = !!(activeDiffItem || lightTab || activeAuxiliaryTab)
  const selectedExternalConflictKey = useMemo(() => {
    if (!selectedExternalChange) return null

    return [
      selectedFilePath ?? '',
      selectedExternalChange.status,
      selectedExternalChange.diskFile?.modifiedAt ?? '',
      selectedExternalChange.diskFile?.size ?? '',
      selectedExternalChange.message ?? '',
    ].join(':')
  }, [selectedExternalChange, selectedFilePath])
  const canKeepLocalExternalConflict =
    selectedExternalChange?.status === 'modified' && !!selectedExternalChange.diskFile
  const shouldShowExternalConflictDialog = selectedExternalChange?.status === 'modified'
  const isApplePlatform = /Mac|iPhone|iPad/.test(navigator.platform)
  const quickOpenShortcut = isApplePlatform ? '⌘P' : 'Ctrl+P'
  const problemsShortcut = isApplePlatform ? '⌘⇧I' : 'Ctrl+Shift+I'
  const gitShortcut = isApplePlatform ? '⌘⇧G' : 'Ctrl+Shift+G'

  function selectFindMatch(index: number): void {
    if (!findMatches.length) return

    const nextIndex = (index + findMatches.length) % findMatches.length
    const match = findMatches[nextIndex]
    setActiveFindIndex(nextIndex)
    setHasActiveFindSelection(true)
    editorRef.current?.selectRange(match.start, match.end)
    onCursorPositionLatest.current?.({ line: match.line, column: match.column })
  }

  function openFindBar(): void {
    if (!selectedFile) return

    setIsGoToLineOpen(false)
    setIsFindOpen(true)
    setActiveFindIndex(0)
    setHasActiveFindSelection(false)
  }

  function closeFindBar(): void {
    setIsFindOpen(false)
    setFindQuery('')
    setActiveFindIndex(0)
    setHasActiveFindSelection(false)
    editorRef.current?.focus()
  }

  function updateFindQuery(query: string): void {
    setFindQuery(query)
    setActiveFindIndex(0)
    setHasActiveFindSelection(false)
  }

  function openGoToLineBar(): void {
    if (!selectedFile) return

    setIsFindOpen(false)
    setIsGoToLineOpen(true)
    setGoToLineInput('')
  }

  function closeGoToLineBar(): void {
    setIsGoToLineOpen(false)
    setGoToLineInput('')
    editorRef.current?.focus()
  }

  function submitGoToLine(): void {
    if (!goToLineTarget) return

    const target = goToLineTarget
    closeGoToLineBar()
    timers.nextFrame(() => editorRef.current?.moveToLine(target.line, target.column), {
      label: 'workbench.editor.goToLine',
    })
  }

  function openTabContextMenu(path: string, event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    setTabContextMenu({
      path,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 188)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 168)),
    })
  }

  function runTabContextAction(action: () => void): void {
    setTabContextMenu(null)
    action()
  }

  useEffect(() => {
    onCursorPositionLatest.current?.({ line: 1, column: 1 })
    setIsGoToLineOpen(false)
    setGoToLineInput('')
    setActiveFindIndex(0)
    setHasActiveFindSelection(false)
    setFileHistoryMode(null)
  }, [selectedFilePath])

  useEffect(() => {
    setFileHistoryMode(null)
  }, [activeDiffItem, activeAuxiliaryTab, lightTab])

  useEffect(() => {
    if (activeFindIndex >= findMatches.length) {
      setActiveFindIndex(0)
    }
  }, [activeFindIndex, findMatches.length])

  useEffect(() => {
    if (!navigationRequest || !selectedFile) return
    // 每个导航请求只应用一次（按单调 id 去重）。selectedFile 仍在依赖里，
    // 以便文件在请求之后才加载完成时能补跳；但保存等操作只是刷新 selectedFile 身份，
    // 不能因此把光标重新拽回上一次导航位置、顺带关掉补全面板。
    if (appliedNavigationRequestIdRef.current === navigationRequest.id) return
    appliedNavigationRequestIdRef.current = navigationRequest.id

    timers.nextFrame(
      () => {
        editorRef.current?.moveToLine(navigationRequest.line, navigationRequest.column)
      },
      { label: 'workbench.editor.navigationRequest' }
    )
  }, [navigationRequest, selectedFile, timers])

  useEffect(() => {
    if (
      !shouldShowExternalConflictDialog ||
      !selectedExternalConflictKey ||
      selectedExternalConflictKey === dismissedExternalConflictKey
    )
      return

    setExternalConflictDialogOpen(true)
  }, [dismissedExternalConflictKey, selectedExternalConflictKey, shouldShowExternalConflictDialog])

  function setExternalConflictDialogState(open: boolean): void {
    setExternalConflictDialogOpen(open)
    if (!open && selectedExternalConflictKey) {
      setDismissedExternalConflictKey(selectedExternalConflictKey)
    }
  }

  function resolveExternalFileConflict(resolution: 'external' | 'local'): void {
    if (resolution === 'local' && !canKeepLocalExternalConflict) return

    if (selectedExternalConflictKey) {
      setDismissedExternalConflictKey(selectedExternalConflictKey)
    }
    setExternalConflictDialogOpen(false)
    onResolveExternalFileConflict(resolution)
  }

  const tabMenuOpen = isPresent(tabContextMenu)
  useDismissOnWindowInteract({
    enabled: tabMenuOpen,
    onDismiss: () => setTabContextMenu(null),
  })

  return (
    <section className={styles.editorPanel}>
      {showTopBar && <WorkbenchTopBar {...chrome} />}
      <div className={styles.editorMain}>
        <EditorTabBar
          openTabs={openTabs}
          selectedFilePath={selectedFilePath}
          selectedFile={hasEditorOverlayTab ? null : selectedFile}
          hasUnsavedChanges={hasEditorOverlayTab ? false : hasUnsavedChanges}
          canEditSelectedFile={hasEditorOverlayTab ? false : canEditSelectedFile}
          isSavingFile={isSavingFile}
          dirtyTabCount={dirtyTabCount}
          gitDecorations={gitDecorations}
          diffTabItem={activeDiffItem}
          lightTabItem={lightTab?.item || null}
          auxiliaryTabItems={auxiliaryTabs}
          tabContextMenu={tabContextMenu}
          onOpenTabContextMenu={openTabContextMenu}
          onRunTabContextAction={runTabContextAction}
          onSelectOpenFile={onSelectOpenFile}
          onCloseOpenFile={onCloseOpenFile}
          onCloseOtherOpenFiles={onCloseOtherOpenFiles}
          onCloseAllOpenFiles={onCloseAllOpenFiles}
          onCloseUnmodifiedOpenFiles={onCloseUnmodifiedOpenFiles}
          onReorderOpenTabs={onReorderOpenTabs}
          onSelectDiffTab={() => undefined}
          onCloseDiffTab={onCloseDiffTab}
          onSelectLightTab={lightTab?.onSelect}
          onCloseLightTab={lightTab?.onClose}
          onSaveAllOpenFiles={onSaveAllOpenFiles}
        />
        <Dialog
          open={!!shouldShowExternalConflictDialog && externalConflictDialogOpen}
          onOpenChange={setExternalConflictDialogState}
        >
          <DialogContent className={styles.editorExternalConflictDialog}>
            <DialogHeader>
              <DialogTitle>{t('workbench.externalFileConflictDialogTitle')}</DialogTitle>
              <DialogDescription>
                {selectedExternalChange?.status === 'modified'
                  ? t('workbench.externalFileConflictDialogDescription', {
                      path: selectedFilePath ?? '',
                    })
                  : (selectedExternalChange?.message ??
                    t('workbench.externalFileUnavailableDescription', {
                      path: selectedFilePath ?? '',
                    }))}
              </DialogDescription>
            </DialogHeader>
            {selectedExternalChange?.status === 'modified' && (
              <div className={styles.editorExternalConflictOptions}>
                <div className={styles.editorExternalConflictOption}>
                  <Text className={styles.editorExternalConflictOptionTitle}>
                    {t('workbench.externalFileConflictLocalOptionTitle')}
                  </Text>
                  <Text tone="secondary">
                    {t('workbench.externalFileConflictLocalOptionDescription')}
                  </Text>
                </div>
                <div className={styles.editorExternalConflictOption}>
                  <Text className={styles.editorExternalConflictOptionTitle}>
                    {t('workbench.externalFileConflictExternalOptionTitle')}
                  </Text>
                  <Text tone="secondary">
                    {t('workbench.externalFileConflictExternalOptionDescription')}
                  </Text>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setExternalConflictDialogState(false)}>
                {t('common.cancel')}
              </Button>
              {selectedExternalChange?.status === 'modified' && (
                <Button
                  variant="outline"
                  disabled={!canKeepLocalExternalConflict}
                  onClick={() => resolveExternalFileConflict('local')}
                >
                  {t('workbench.keepLocalDraft')}
                </Button>
              )}
              <Button
                className={styles.editorDefaultActionButton}
                onClick={() => resolveExternalFileConflict('external')}
              >
                {t('workbench.useExternalVersion')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <div className={styles.editorViewport}>
          {debugTabsLayer}
          {!!fileHistoryMode && selectedFile ? (
            <FileHistoryView
              projectRoot={projectRoot}
              path={selectedFile.path}
              workbenchTheme={workbenchTheme}
              initialMode={fileHistoryMode}
              currentContent={editorContent}
              onRestore={(content) => {
                onEditorContentChange(content)
                setFileHistoryMode(null)
              }}
              onClose={() => setFileHistoryMode(null)}
            />
          ) : activeAuxiliaryTab ? (
            <>{toNullable(activeAuxiliaryTab.content)}</>
          ) : activeDiffItem ? (
            chatChangePreview?.items.some((item) =>
              isSameWorkbenchGitChangeItem(item, activeDiffItem)
            ) ? (
              <WorkbenchChatChangePreviewPanel
                projectRoot={projectRoot}
                workbenchTheme={workbenchTheme}
                activeItem={activeDiffItem}
                items={chatChangePreview.items}
                pendingFileAction={chatChangePreview.pendingFileAction}
                onClose={chatChangePreview.onClose}
                onDiscardItem={chatChangePreview.onDiscardItem}
                onSelectItem={chatChangePreview.onSelectItem}
                onOpenFile={chatChangePreview.onOpenFile}
              />
            ) : (
              <GitDiffEditorPanel
                projectRoot={projectRoot}
                item={activeDiffItem}
                workbenchTheme={workbenchTheme}
              />
            )
          ) : lightTab ? (
            <WorkbenchLightFilePanel
              tab={lightTab.item}
              readOnly={lightTab.readOnly}
              workbenchTheme={workbenchTheme}
              onContentChange={lightTab.onContentChange}
              onSave={lightTab.onSave}
            />
          ) : (
            <>
              {!!(isFindOpen && selectedFile) && (
                <EditorFindBar
                  findQuery={findQuery}
                  findMatches={findMatches}
                  activeFindIndex={activeFindIndex}
                  hasActiveFindSelection={hasActiveFindSelection}
                  onFindQueryChange={updateFindQuery}
                  onClose={closeFindBar}
                  onSelectMatch={selectFindMatch}
                />
              )}
              {!!(isGoToLineOpen && selectedFile) && (
                <EditorGoToLineBar
                  goToLineInput={goToLineInput}
                  editorLineCount={editorLineCount}
                  goToLineTarget={goToLineTarget}
                  onGoToLineInputChange={setGoToLineInput}
                  onSubmit={submitGoToLine}
                  onClose={closeGoToLineBar}
                />
              )}
              {!!selectedExternalChange && (
                <div
                  className={styles.editorExternalChangeBanner}
                  data-status={selectedExternalChange.status}
                >
                  <WarningCircleIcon size={16} />
                  <div>
                    <Text className={styles.editorExternalChangeTitle}>
                      {selectedExternalChange.status === 'modified'
                        ? t('workbench.externalFileChangedTitle')
                        : t('workbench.externalFileUnavailableTitle')}
                    </Text>
                    <Text tone="secondary" truncate>
                      {selectedExternalChange.status === 'modified'
                        ? t('workbench.externalFileChangedDescription', {
                            path: selectedFilePath ?? '',
                          })
                        : (selectedExternalChange.message ??
                          t('workbench.externalFileUnavailableDescription', {
                            path: selectedFilePath ?? '',
                          }))}
                    </Text>
                  </div>
                  {canKeepLocalExternalConflict && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveExternalFileConflict('local')}
                    >
                      {t('workbench.keepLocalDraft')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveExternalFileConflict('external')}
                  >
                    {selectedExternalChange.status === 'modified'
                      ? t('workbench.useExternalVersion')
                      : t('workbench.reloadFromDisk')}
                  </Button>
                </div>
              )}
              {!!selectedFile && (
                <EditorFileDiagnosticSummary
                  diagnostics={selectedFileDiagnostics}
                  onOpenProblems={onToggleProblems}
                  onNavigatePrevious={() => navigateToDiagnostic('previous')}
                  onNavigateNext={() => navigateToDiagnostic('next')}
                />
              )}
              <div className={styles.editorScroll}>
                {selectedFile ? (
                  <Suspense fallback={null}>
                    <LazyCodeMirrorEditor
                      ref={editorRef}
                      projectRoot={projectRoot}
                      path={selectedFile.path}
                      language={selectedLanguage}
                      value={editorContent}
                      readOnly={!canEditSelectedFile || selectedFile.truncated}
                      disabled={false}
                      projectContextIndex={projectContextIndex}
                      openTabs={openTabs}
                      packageManager={selectedPackageManager}
                      workbenchTheme={workbenchTheme}
                      onChange={onEditorContentChange}
                      onCursorPositionChange={handleCursorPositionChange}
                      onOpenFind={openFindBar}
                      onOpenGoToLine={openGoToLineBar}
                      onGoToDefinition={onGoToDefinition}
                      onApplyLanguageServiceFileChanges={onApplyLanguageServiceFileChanges}
                      onRunPackageScript={onRunPackageScript}
                      onOpenFileHistory={setFileHistoryMode}
                      onSave={onSaveSelectedFile}
                    />
                  </Suspense>
                ) : (
                  <div className={styles.editorEmpty} data-embedded={!showTopBar}>
                    <div className={styles.editorEmptyCard}>
                      {showTopBar && (
                        <div className={styles.editorEmptyShortcuts}>
                          <div className={styles.editorEmptyShortcutRow}>
                            <Text>{t('workbench.globalSearchFiles')}</Text>
                            <kbd>{quickOpenShortcut}</kbd>
                          </div>
                          <div className={styles.editorEmptyShortcutRow}>
                            <Text>{t('workbench.editorEmptyProblems')}</Text>
                            <kbd>{problemsShortcut}</kbd>
                          </div>
                          <div className={styles.editorEmptyShortcutRow}>
                            <Text>{t('workbench.editorEmptyGit')}</Text>
                            <kbd>{gitShortcut}</kbd>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
