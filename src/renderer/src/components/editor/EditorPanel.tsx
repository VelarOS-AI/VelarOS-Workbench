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
  workbenchEditorFileStateKey,
  WorkbenchEditorFileStates,
} from '@renderer/models/editor/workbenchEditorFileStates'
import {
  DefaultWorkbenchEditorFindOptions,
  EmptyWorkbenchEditorFindStatus,
  type WorkbenchEditorFindOptions,
  type WorkbenchEditorFindRequest,
} from '@renderer/models/editor/workbenchEditorFindState'
import {
  getWorkbenchEditorLineCount,
  parseWorkbenchGoToLineInput,
} from '@renderer/models/editor/workbenchEditorModel'
import { isDirtyTab } from '@renderer/models/editor/workbenchEditorTabs'
import type {
  WorkbenchIndentation,
  WorkbenchIndentationRequest,
} from '@renderer/models/editor/workbenchIndentation'
import { isWorkbenchMarkdownPreviewPath } from '@renderer/models/editor/workbenchMarkdownPreview'
import {
  navigateWorkbenchSymbolLocations,
  openWorkbenchSymbolLocations,
  sameWorkbenchSymbolLocation,
  type WorkbenchSymbolLocationsRequest,
  type WorkbenchSymbolLocationsState,
} from '@renderer/models/editor/workbenchSymbolLocations'
import {
  type WorkbenchGitChangeItem,
  type WorkbenchGitDecorationMap,
} from '@renderer/models/git/workbenchGitModel'
import {
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  formatWorkbenchShortcutHint,
  type WorkbenchKeyboardShortcutMap,
} from '@renderer/models/layout/workbenchKeyboardShortcuts'
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
  WorkbenchLanguageServiceLocation,
} from '@shared/contracts'
import { resolveWorkbenchTextOffset } from '@shared/workbenchSearchText'
import { normalizeWorkbenchTextEol, type WorkbenchTextFormat } from '@shared/workbenchTextFormat'
import { DefaultWorkbenchTextFormat } from '@shared/workbenchTextFormat'

import { useWorkbenchGitBlame } from '../../hooks/useWorkbenchGitBlame'
import { useWorkbenchGitHeadContent } from '../../hooks/useWorkbenchGitHeadContent'
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
  IsolatedWorkbenchEditorTabGroups,
  type WorkbenchEditorAuxiliaryTabItem,
} from './EditorTabBar'
import { EditorTextFormatNotice } from './EditorTextFormatNotice'
import { type FileHistoryMode,FileHistoryView } from './FileHistoryView'
import { WorkbenchImagePreview } from './WorkbenchImagePreview'
import { WorkbenchLightFilePanel } from './WorkbenchLightFilePanel'

interface CodeMirrorEditorModule {
  CodeMirrorEditor: typeof CodeMirrorEditorComponent
}

interface WorkbenchMarkdownPreviewModule {
  WorkbenchMarkdownPreview: typeof import('./WorkbenchMarkdownPreview').WorkbenchMarkdownPreview
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

const LazyWorkbenchMarkdownPreview = lazy(async () => {
  const module: WorkbenchMarkdownPreviewModule = await import('./WorkbenchMarkdownPreview')
  return { default: module.WorkbenchMarkdownPreview }
})

export interface WorkbenchEditorPanelTabsProps {
  onSelectOpenFile: (path: string) => void
  /** 关标签；有未保存改动的先问「保存 / 不保存 / 取消」。 */
  onCloseOpenFile: (path: string) => void
  onCloseOtherOpenFiles: (path: string) => void
  onCloseAllOpenFiles: () => void
  onCloseUnmodifiedOpenFiles: () => void
  /** 关掉这个标签右边的所有标签。 */
  onCloseOpenFilesToRight: (path: string) => void
  /** 放弃这个标签里没保存的改动，回到磁盘上的版本。 */
  onRevertOpenFile: (path: string) => void
  onReorderOpenTabs: (fromPath: string, toPath: string) => void
  /** ⌘W / Ctrl+W 的请求序号：变了就关掉编辑区当前在前台的标签（没有标签就什么也不做）。 */
  closeActiveTabRequestId?: number
}

export interface WorkbenchEditorPanelAuxiliaryTab extends WorkbenchEditorAuxiliaryTabItem {
  content: ReactNode
}

export interface WorkbenchEditorPanelDiffProps {
  diffWorkspaceRoot: string
  activeDiffItem?: LooseOptional<WorkbenchGitChangeItem>
  focusFirstChangeRequestId?: number
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
  /** 在差异里按块暂存、回滚之后：刷新 Git 状态。 */
  onGitStateChanged?: () => Promise<void> | void
}

export interface WorkbenchEditorPanelWorkspaceProps {
  /** 保存当前文件；`content` 是编辑器这一刻的正文（⌘S 时可能刚格式化过）。 */
  onSaveSelectedFile: (content?: string) => void
  /** 当前文件在只读与编辑之间切换（只挡用户在编辑器里输入，AI 经内核写盘不受影响）。 */
  onToggleSelectedFileEditMode: () => void
  onSaveAllOpenFiles: () => void
  /** 用户明确选的格式转换（转换为 UTF-8、换换行符）：记为未保存并立即保存。 */
  onConvertSelectedFileTextFormat?: (format: WorkbenchTextFormat) => void
  onResolveExternalFileConflict: (resolution: 'external' | 'local') => void
  onEditorContentChange: (content: string) => void
  onOpenDirectory: (path: string) => void
  onRevealSelectedFile: () => void
  onGoToDefinition: (path: string, line: number, column?: number) => void
  onApplyLanguageServiceRename?: (
    changes: WorkbenchLanguageServiceFileEdit[],
    options?: { editedInEditor?: number }
  ) => void
  packageManager: PackageManagerCommand
  onRunPackageScript: (command: string) => void
  /** 右键「添加到聊天」（编辑器与标签页）：把文件作为引用挂到聊天输入框，只挂路径。 */
  onAddFilesToChat?: (paths: readonly string[]) => void
  onOpenQuickOpen: () => void
  onToggleGitTool: () => void
  onToggleProblems: () => void
  /** 当前快捷键设置：空编辑区里的快捷键提示按它现算。 */
  keymap?: WorkbenchKeyboardShortcutMap
  /** 编辑区的后退 / 前进（Windows / Linux 上编辑器里的 Alt+← / Alt+→ 也走这里）。 */
  onNavigateBack?: () => void
  onNavigateForward?: () => void
  /** 要在当前文件里跳到别处（跳到行）：先把当前位置记进后退历史。 */
  onNavigationPoint?: () => void
  /** 当前文件实际用的缩进（给状态栏）；状态栏缩进菜单的操作经 `indentationRequest` 交回编辑器。 */
  onIndentationChange?: (indentation: Nullable<WorkbenchIndentation>) => void
  indentationRequest?: Nullable<WorkbenchIndentationRequest>
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
  /**
   * 版本库状态的刷新序号（工作区改动、提交、切分支之后都会变），编辑区据此重读当前文件在 HEAD 里的
   * 全文来标 Git 改动；null 表示项目不是 Git 仓库。
   */
  gitStateRevision?: Nullable<number>
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
  gitStateRevision = null,
  selectedFileDiagnostics = [],
  tabs: {
    onSelectOpenFile,
    onCloseOpenFile,
    onCloseOtherOpenFiles,
    onCloseAllOpenFiles,
    onCloseUnmodifiedOpenFiles,
    onCloseOpenFilesToRight,
    onRevertOpenFile,
    onReorderOpenTabs,
    closeActiveTabRequestId = 0,
  },
  diff: {
    activeDiffItem = null,
    focusFirstChangeRequestId = 0,
    auxiliaryTabs = [],
    debugTabsLayer = null,
    lightTab = null,
    onCloseDiffTab,
    onGitStateChanged,
  },
  workspace: {
    onSaveSelectedFile,
    onToggleSelectedFileEditMode,
    onSaveAllOpenFiles,
    onConvertSelectedFileTextFormat,
    onResolveExternalFileConflict,
    onEditorContentChange,
    onGoToDefinition,
    onApplyLanguageServiceRename,
    packageManager,
    onRunPackageScript,
    onAddFilesToChat,
    onToggleProblems,
    keymap = DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
    onNavigateBack,
    onNavigateForward,
    onNavigationPoint,
    onIndentationChange,
    indentationRequest = null,
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
    selectedFileEditMode,
    projectContextIndex,
    isSavingFile,
    autosaveFailures,
    externalRevision,
  } = workbenchEditor
  const { t } = useWorkbenchI18n()
  const onCursorPositionLatest = useLatest(onCursorPositionChange)
  const editorContentLatest = useLatest(editorContent)
  const editorRef = useRef<CodeMirrorEditorHandle>(null)
  const appliedNavigationRequestIdRef = useRef<Nullable<number>>(null)
  const [isFindOpen, setIsFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findReplace, setFindReplace] = useState('')
  const [isFindReplaceOpen, setIsFindReplaceOpen] = useState(false)
  const [findOptions, setFindOptions] = useState(DefaultWorkbenchEditorFindOptions)
  const [findStatus, setFindStatus] = useState(EmptyWorkbenchEditorFindStatus)
  /** 每次要求查找框拿焦点并全选就加一。 */
  const [findFocusRequest, setFindFocusRequest] = useState(0)
  const [isGoToLineOpen, setIsGoToLineOpen] = useState(false)
  const [markdownPreviewPaths, setMarkdownPreviewPaths] = useState<ReadonlySet<string>>(
    () => new Set()
  )
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
  const [symbolLocations, setSymbolLocations] =
    useState<Nullable<WorkbenchSymbolLocationsState>>(null)
  const [symbolLocationsVisible, setSymbolLocationsVisible] = useState(false)
  const [activeDiagnosticIndex, setActiveDiagnosticIndex] = useState(-1)
  const onActiveProblemIdChangeLatest = useLatest(onActiveProblemIdChange)
  const lastSyncedProblemIdRef = useRef<Nullable<string>>(null)
  // 各打开文件的编辑器状态（撤销历史、光标、折叠、滚动位置）放在这里：编辑器切到预览、对比视图时会卸载，
  // 挂回来接着用；标签关掉就丢。
  const [editorFileStates] = useState(() => new WorkbenchEditorFileStates())
  useEffect(() => {
    editorFileStates.retain(openTabs.map((tab) => workbenchEditorFileStateKey(projectRoot, tab.path)))
  }, [editorFileStates, openTabs, projectRoot])

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
  const selectedImagePreview = selectedFile?.imagePreview
  // 截断打开的文件只有前一部分正文，跟 HEAD 全文比会把后面整段算成删除：不标。
  const gitHeadContent = useWorkbenchGitHeadContent({
    projectRoot,
    path:
      selectedFile && !selectedFile.truncated && !selectedImagePreview ? selectedFile.path : null,
    revision: gitStateRevision,
  })
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
  // 查找栏开着才交给编辑器；同一组值保持同一个对象，编辑器据此判断查找词或开关项有没有变。
  const findRequest = useMemo<Nullable<WorkbenchEditorFindRequest>>(
    () => (isFindOpen ? { query: findQuery, replace: findReplace, ...findOptions } : null),
    [findOptions, findQuery, findReplace, isFindOpen]
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
  const openSymbolLocations = useCallback((
    request: WorkbenchSymbolLocationsRequest,
    visible?: boolean
  ) => {
    setSymbolLocations((current) => {
      const opened = openWorkbenchSymbolLocations(request)
      if (
        current?.returnLocation
        && sameWorkbenchSymbolLocation(current.activeLocation, opened.activeLocation)
      ) return { ...opened, returnLocation: current.returnLocation }
      return opened
    })
    if (visible !== undefined) setSymbolLocationsVisible(visible)
  }, [])
  const navigateSymbolLocation = useCallback(
    (location: WorkbenchLanguageServiceLocation) => {
      if (
        symbolLocations &&
        sameWorkbenchSymbolLocation(symbolLocations.activeLocation, location)
      )
        return

      setSymbolLocations((current) =>
        current ? navigateWorkbenchSymbolLocations(current, location) : current
      )
      onGoToDefinition(location.path, location.line, location.column)
    },
    [onGoToDefinition, symbolLocations]
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
  const dirtyTabCount = useMemo(() => openTabs.filter(isDirtyTab).length, [openTabs])
  const selectedTab = useMemo(
    () => toNullable(openTabs.find((tab) => tab.path === selectedFilePath)),
    [openTabs, selectedFilePath]
  )
  const selectedExternalChange = toNullable(selectedTab?.externalChange)
  // Git 追溯栏：开着就一直开着，换文件时查新文件的（截断打开的文件行号对不上，不查）。
  const [gitBlameVisible, setGitBlameVisible] = useState(false)
  const gitBlame = useWorkbenchGitBlame({
    projectRoot,
    path:
      gitBlameVisible && selectedFile && !selectedFile.truncated && !selectedImagePreview
        ? selectedFile.path
        : null,
    revision: gitStateRevision,
    savedAt: toNullable(selectedFile?.modifiedAt),
    // 按磁盘上的编码与换行符（Git 比的是提交里的字节），不按还没存下去的转换。
    format: selectedFile
      ? { encoding: selectedFile.encoding, eol: selectedFile.eol }
      : DefaultWorkbenchTextFormat,
    readContent: () => editorContentLatest.current,
  })
  const activeAuxiliaryTab = useMemo(
    () => toNullable(auxiliaryTabs.find((tab) => tab.active)),
    [auxiliaryTabs]
  )
  // 独占组（结构图、AI 改动）激活时标签栏只显示这一组；否则独占组的标签都不在普通标签栏里。
  const isolatedTabGroup =
    activeAuxiliaryTab?.group && IsolatedWorkbenchEditorTabGroups.has(activeAuxiliaryTab.group)
      ? activeAuxiliaryTab.group
      : null
  const visibleAuxiliaryTabs = useMemo(
    () => auxiliaryTabs.filter((tab) =>
      isolatedTabGroup
        ? tab.group === isolatedTabGroup
        : !tab.group || !IsolatedWorkbenchEditorTabGroups.has(tab.group)),
    [auxiliaryTabs, isolatedTabGroup]
  )
  const hasEditorOverlayTab = !!(activeDiffItem || lightTab || activeAuxiliaryTab)
  const markdownPreviewAvailable =
    !hasEditorOverlayTab && isWorkbenchMarkdownPreviewPath(selectedFilePath)
  const markdownPreviewActive =
    markdownPreviewAvailable && !!selectedFilePath && markdownPreviewPaths.has(selectedFilePath)
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
  const quickOpenShortcut = formatWorkbenchShortcutHint(keymap['quick-open'])
  const problemsShortcut = formatWorkbenchShortcutHint(keymap['toggle-problems'])
  const gitShortcut = formatWorkbenchShortcutHint(keymap['toggle-changes'])

  /** 打开查找栏：`seed` 是预填的查找词，`withReplace` 连替换行一起展开。已经开着就把焦点放回查找框。 */
  function openFindBar(seed?: string, withReplace = false): void {
    if (!selectedFile || selectedImagePreview || markdownPreviewActive) return

    setIsGoToLineOpen(false)
    if (seed) setFindQuery(seed)
    if (withReplace) setIsFindReplaceOpen(true)
    setIsFindOpen(true)
    setFindFocusRequest((request) => request + 1)
  }

  function closeFindBar(): void {
    setIsFindOpen(false)
    setFindStatus(EmptyWorkbenchEditorFindStatus)
    editorRef.current?.focus()
  }

  function toggleFindOption(option: keyof WorkbenchEditorFindOptions): void {
    setFindOptions((current) => ({ ...current, [option]: !current[option] }))
  }

  function openGoToLineBar(): void {
    if (!selectedFile || selectedImagePreview) return

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
    onNavigationPoint?.()
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

  function toggleMarkdownPreview(): void {
    if (!markdownPreviewAvailable || !selectedFilePath) return
    setIsFindOpen(false)
    setIsGoToLineOpen(false)
    setMarkdownPreviewPaths((current) => {
      const next = new Set(current)
      if (next.has(selectedFilePath)) next.delete(selectedFilePath)
      else next.add(selectedFilePath)
      return next
    })
  }

  useEffect(() => {
    // 代码编辑器换文件时自己报光标（换回来的文件回到上次的位置）；图片、Markdown 预览没有光标，从头算。
    if (!selectedFile || selectedImagePreview || markdownPreviewActive) {
      setCursorPosition((current) =>
        current.line === 1 && current.column === 1 ? current : { line: 1, column: 1 }
      )
      onCursorPositionLatest.current?.({ line: 1, column: 1 })
    }
    // 查找栏跟着换过去的文件接着找（与 VS Code 一样不关）；「在选区中查找」的范围属于上一个文件，关掉。
    setFindOptions((current) => (current.inSelection ? { ...current, inSelection: false } : current))
    setIsGoToLineOpen(false)
    setGoToLineInput('')
    setFileHistoryMode(null)
  }, [selectedFilePath])

  useEffect(() => {
    setFileHistoryMode(null)
  }, [activeDiffItem, activeAuxiliaryTab, lightTab])


  useEffect(() => {
    if (!navigationRequest || !selectedFile) return
    // 每个导航请求只应用一次（按单调 id 去重）。selectedFile 仍在依赖里，
    // 以便文件在请求之后才加载完成时能补跳；但保存等操作只是刷新 selectedFile 身份，
    // 不能因此把光标重新拽回上一次导航位置、顺带关掉补全面板。
    if (appliedNavigationRequestIdRef.current === navigationRequest.id) return
    appliedNavigationRequestIdRef.current = navigationRequest.id

    timers.nextFrame(
      () => {
        const options = { focus: navigationRequest.focus }
        if (navigationRequest.endColumn) {
          // 行列按编辑器里的正文换成偏移（与编辑器同样的 LF 正文）。
          const content = editorContentLatest.current
          const endLine = navigationRequest.endLine ?? navigationRequest.line
          editorRef.current?.selectRange(
            resolveWorkbenchTextOffset(content, navigationRequest.line, navigationRequest.column ?? 1),
            resolveWorkbenchTextOffset(content, endLine, navigationRequest.endColumn)
          )
        } else if (navigationRequest.endLine)
          editorRef.current?.selectLines(navigationRequest.line, navigationRequest.endLine, options)
        else
          editorRef.current?.moveToLine(navigationRequest.line, navigationRequest.column, options)
      },
      { label: 'workbench.editor.navigationRequest' }
    )
  }, [editorContentLatest, navigationRequest, selectedFile, timers])

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

  /** 关掉编辑区前台的那个标签，顺序与画面一致：文件历史、辅助标签、差异、轻量预览、文件。 */
  function closeActiveEditorTab(): void {
    if (fileHistoryMode && selectedFile) {
      setFileHistoryMode(null)
      return
    }
    if (activeAuxiliaryTab) {
      activeAuxiliaryTab.onClose?.()
      return
    }
    if (activeDiffItem) {
      onCloseDiffTab?.()
      return
    }
    if (lightTab) {
      lightTab.onClose()
      return
    }
    if (selectedFilePath) onCloseOpenFile(selectedFilePath)
  }

  const handledCloseActiveTabRequestIdRef = useRef(closeActiveTabRequestId)
  useEffect(() => {
    if (handledCloseActiveTabRequestIdRef.current === closeActiveTabRequestId) return

    handledCloseActiveTabRequestIdRef.current = closeActiveTabRequestId
    closeActiveEditorTab()
  })

  return (
    <section className={styles.editorPanel}>
      {showTopBar && <WorkbenchTopBar {...chrome} />}
      <div className={styles.editorMain}>
        <EditorTabBar
          openTabs={isolatedTabGroup ? [] : openTabs}
          selectedFilePath={isolatedTabGroup ? null : selectedFilePath}
          selectedFile={hasEditorOverlayTab ? null : selectedFile}
          hasUnsavedChanges={hasEditorOverlayTab ? false : hasUnsavedChanges}
          canEditSelectedFile={hasEditorOverlayTab ? false : canEditSelectedFile}
          selectedFileEditMode={hasEditorOverlayTab ? null : selectedFileEditMode}
          onToggleSelectedFileEditMode={onToggleSelectedFileEditMode}
          isSavingFile={isSavingFile}
          dirtyTabCount={dirtyTabCount}
          autosaveFailures={autosaveFailures}
          gitDecorations={gitDecorations}
          diffTabItem={isolatedTabGroup ? null : activeDiffItem}
          lightTabItem={isolatedTabGroup ? null : lightTab?.item || null}
          auxiliaryTabItems={visibleAuxiliaryTabs}
          tabContextMenu={tabContextMenu}
          onOpenTabContextMenu={openTabContextMenu}
          onRunTabContextAction={runTabContextAction}
          onSelectOpenFile={onSelectOpenFile}
          onCloseOpenFile={onCloseOpenFile}
          onCloseOtherOpenFiles={onCloseOtherOpenFiles}
          onCloseAllOpenFiles={onCloseAllOpenFiles}
          onCloseUnmodifiedOpenFiles={onCloseUnmodifiedOpenFiles}
          onCloseOpenFilesToRight={onCloseOpenFilesToRight}
          onRevertOpenFile={onRevertOpenFile}
          onAddFileToChat={onAddFilesToChat ? (path) => onAddFilesToChat([path]) : undefined}
          onReorderOpenTabs={onReorderOpenTabs}
          onSelectDiffTab={() => undefined}
          onCloseDiffTab={onCloseDiffTab}
          onSelectLightTab={lightTab?.onSelect}
          onCloseLightTab={lightTab?.onClose}
          onSaveAllOpenFiles={onSaveAllOpenFiles}
          markdownPreviewAvailable={markdownPreviewAvailable}
          markdownPreviewActive={markdownPreviewActive}
          onToggleMarkdownPreview={toggleMarkdownPreview}
          ariaLabel={
            isolatedTabGroup === 'structure'
              ? t('workbench.logicGraphStructureView')
              : isolatedTabGroup === 'ai-changes'
                ? t('workbench.aiChangesTitle')
                : undefined
          }
          showWorkspaceActions={!isolatedTabGroup}
        />
        <Dialog
          open={!!shouldShowExternalConflictDialog && externalConflictDialogOpen}
          onOpenChange={setExternalConflictDialogState}
        >
          <DialogContent>
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
                // 历史快照可能带着 CRLF：编辑缓冲一律是 LF，保存时再换回文件的换行符。
                onEditorContentChange(normalizeWorkbenchTextEol(content))
                setFileHistoryMode(null)
              }}
              onClose={() => setFileHistoryMode(null)}
            />
          ) : activeAuxiliaryTab ? (
            <>{toNullable(activeAuxiliaryTab.content)}</>
          ) : activeDiffItem ? (
            <GitDiffEditorPanel
              projectRoot={projectRoot}
              item={activeDiffItem}
              workbenchTheme={workbenchTheme}
              focusFirstChangeRequestId={focusFirstChangeRequestId}
              hasUnsavedOpenTabs={chrome.hasUnsavedOpenTabs}
              onGitStateChanged={onGitStateChanged}
            />
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
              {!!(isFindOpen && selectedFile && !selectedImagePreview && !markdownPreviewActive) && (
                <EditorFindBar
                  query={findQuery}
                  replace={findReplace}
                  options={findOptions}
                  status={findStatus}
                  replaceOpen={isFindReplaceOpen}
                  readOnly={!canEditSelectedFile || !!selectedFile.truncated}
                  focusRequest={findFocusRequest}
                  onQueryChange={setFindQuery}
                  onReplaceChange={setFindReplace}
                  onToggleOption={toggleFindOption}
                  onToggleReplace={() => setIsFindReplaceOpen((open) => !open)}
                  onFindNext={() => editorRef.current?.findNext()}
                  onFindPrevious={() => editorRef.current?.findPrevious()}
                  onReplace={() => editorRef.current?.replaceNext()}
                  onReplaceAll={() => editorRef.current?.replaceAll()}
                  onClose={closeFindBar}
                />
              )}
              {!!(isGoToLineOpen && selectedFile && !selectedImagePreview) && (
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
                        : selectedExternalChange.status === 'deleted'
                          ? t('workbench.externalFileDeletedTitle')
                          : t('workbench.externalFileUnavailableTitle')}
                    </Text>
                    <Text tone="secondary" truncate>
                      {selectedExternalChange.status === 'modified'
                        ? t('workbench.externalFileChangedDescription', {
                            path: selectedFilePath ?? '',
                          })
                        : selectedExternalChange.status === 'deleted'
                          ? t(
                              selectedImagePreview
                                ? 'workbench.externalImageDeletedDescription'
                                : 'workbench.externalFileDeletedDescription',
                              { path: selectedFilePath ?? '' }
                            )
                          : t('workbench.externalFileUnavailableDescription', {
                              path: selectedFilePath ?? '',
                            })}
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
                  {selectedExternalChange.status === 'deleted' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => selectedFilePath && onCloseOpenFile(selectedFilePath)}
                    >
                      {t('workbench.closeDeletedFileTab')}
                    </Button>
                  )}
                  {!(selectedExternalChange.status === 'deleted' && selectedImagePreview) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isSavingFile}
                      onClick={() => resolveExternalFileConflict('external')}
                    >
                      {selectedExternalChange.status === 'modified'
                        ? t('workbench.useExternalVersion')
                        : selectedExternalChange.status === 'deleted'
                          ? t('workbench.restoreDeletedFile')
                          : t('workbench.reloadFromDisk')}
                    </Button>
                  )}
                </div>
              )}
              {!!selectedTab && (
                <EditorTextFormatNotice
                  tab={selectedTab}
                  disabled={isSavingFile}
                  onConvert={onConvertSelectedFileTextFormat}
                />
              )}
              <div className={styles.editorScroll}>
                {/* 问题计数浮在代码区右上角：放在滚动区里，不压住上面的查找栏、跳行栏和提示条。 */}
                {!!selectedFile && !selectedImagePreview && (
                  <EditorFileDiagnosticSummary
                    diagnostics={selectedFileDiagnostics}
                    onOpenProblems={onToggleProblems}
                    onNavigatePrevious={() => navigateToDiagnostic('previous')}
                    onNavigateNext={() => navigateToDiagnostic('next')}
                  />
                )}
                {selectedFile ? (
                  selectedImagePreview ? (
                    <WorkbenchImagePreview
                      path={selectedFile.path}
                      size={selectedFile.size}
                      preview={selectedImagePreview}
                    />
                  ) : markdownPreviewActive ? (
                    <Suspense fallback={null}>
                      <LazyWorkbenchMarkdownPreview
                        path={selectedFile.path}
                        content={editorContent}
                        onOpenProjectPath={(path) => onGoToDefinition(path, 1, 1)}
                      />
                    </Suspense>
                  ) : (
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
                        externalRevision={externalRevision}
                        gitHeadContent={gitHeadContent}
                        gitBlame={gitBlame}
                        onToggleGitBlame={() => setGitBlameVisible((visible) => !visible)}
                        fileStates={editorFileStates}
                        onChange={onEditorContentChange}
                        onCursorPositionChange={handleCursorPositionChange}
                        onOpenFind={openFindBar}
                        onCloseFind={closeFindBar}
                        find={findRequest}
                        onFindStatusChange={setFindStatus}
                        onOpenGoToLine={openGoToLineBar}
                        onNavigateBack={onNavigateBack}
                        onNavigateForward={onNavigateForward}
                        onIndentationChange={onIndentationChange}
                        indentationRequest={indentationRequest}
                        onGoToDefinition={onGoToDefinition}
                        symbolLocations={symbolLocationsVisible ? symbolLocations : null}
                        onOpenSymbolLocations={openSymbolLocations}
                        onCloseSymbolLocations={() => setSymbolLocationsVisible(false)}
                        onNavigateSymbolLocation={navigateSymbolLocation}
                        onApplyLanguageServiceRename={onApplyLanguageServiceRename}
                        onRunPackageScript={onRunPackageScript}
                        onOpenFileHistory={setFileHistoryMode}
                        onAddToChat={
                          onAddFilesToChat ? () => onAddFilesToChat([selectedFile.path]) : undefined
                        }
                        onSave={onSaveSelectedFile}
                      />
                    </Suspense>
                  )
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
