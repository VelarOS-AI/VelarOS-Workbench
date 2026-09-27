import { useEffect, useMemo, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import { applyWorkbenchLanguageServiceEditsToContent } from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import {
  canEditWorkbenchFileContent,
  canSaveWorkbenchTabContent,
  isWorkbenchFileEditable,
  resolveWorkbenchEditorEditMode,
  type WorkbenchEditorEditMode,
} from '@renderer/models/editor/workbenchEditorEditMode'
import {
  appendWorkbenchEditorSavedSnapshot,
  resolveWorkbenchEditorSaveBase,
  summarizeWorkbenchEditorSaveResults,
  type WorkbenchEditorSavedSnapshot,
  type WorkbenchEditorSaveResult,
  type WorkbenchEditorSaveSummary,
} from '@renderer/models/editor/workbenchEditorSaving'
import {
  buildExternalChangeNoticeKey,
  getWorkbenchEditorFilesChangedRefreshDelayMs,
  hasFileSnapshotChanged,
  isDirtyTab,
  mayAffectWorkbenchDiagnostics,
  movePath,
  resolveExternalFileUnavailableStatus,
  resolveWorkbenchEditorRereadMaxChars,
  reuseWorkbenchOpenFileSnapshots,
  WORKBENCH_EDITOR_FILES_CHANGED_DEBOUNCE_MS,
} from '@renderer/models/editor/workbenchEditorTabs'
import {
  resolveWorkbenchTabTextFormat,
  resolveWorkbenchTextConversion,
} from '@renderer/models/editor/workbenchEditorTextFormat'
import type { WorkbenchOpenFileSnapshot } from '@renderer/models/project/workbenchProjectContextIndex'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import { readWorkbenchLocalHistoryThrottleMs } from '@renderer/models/settings/workbenchPreferences'
import { isSameOrChildPath } from '@renderer/models/shared/workbenchUtils'
import type {
  WorkbenchOpenEditorExternalChange,
  WorkbenchOpenEditorTab,
} from '@renderer/types/workbenchTypes'

import { isEmpty, Log, optionalWhenLazy, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type {
  SystemWorkspaceFilesChangedEvent,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchReadFileResult,
} from '@shared/contracts'
import { isWorkbenchImagePreviewPath } from '@shared/workbenchImage'
import {
  type WorkbenchTextFormat,
  WorkbenchUnencodableTextErrorCode,
} from '@shared/workbenchTextFormat'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { subscribeWorkbenchAgentProjectWrites } from '../runtime/workbenchAgentProjectWrites'
import { useLatest, useMemoizedFn, useMonotonicAsyncRequest, useTimerScope } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'

import { useWorkbenchEditorAutosave } from './useWorkbenchEditorAutosave'

const EXTERNAL_FILE_READ_MAX_CHARS = 300_000
const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024
const EXTERNAL_FILE_REFRESH_CONCURRENCY = 4
const log = Log.tag('workbench-editor-controller')

interface WorkbenchExternalFileReadOutcome {
  path: string
  baseFile: WorkbenchReadFileResult
  diskFile: Nullable<WorkbenchReadFileResult>
  error: Nullable<AppError>
}

async function readWorkbenchEditorFile(
  projectRoot: string,
  path: string,
  maxChars: number
): Promise<WorkbenchReadFileResult> {
  if (isWorkbenchImagePreviewPath(path))
    return Result.unwrap(
      await workbenchHost.kernel.project.readWorkbenchImageFile({
        projectRoot,
        path,
        maxBytes: IMAGE_PREVIEW_MAX_BYTES,
      })
    )

  return Result.unwrap(
    await workbenchHost.kernel.project.readWorkbenchFile({ projectRoot, path, maxChars })
  )
}

interface UseWorkbenchEditorControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  onFileMetadataSaved: (file: WorkbenchReadFileResult) => void
  onFileSaved: () => void
  onExternalFilesChanged: () => void
}

interface WorkbenchFileOpenOptions {
  quiet?: boolean
}

interface WorkbenchSaveEditorTabOptions {
  notify?: boolean
  silent?: boolean
}

export function useWorkbenchEditorController({
  activeProject,
  onFileMetadataSaved,
  onFileSaved,
  onExternalFilesChanged,
}: UseWorkbenchEditorControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [selectedFilePath, setSelectedFilePath] = useState<Nullable<string>>(null)
  const [selectedFile, setSelectedFile] = useState<Nullable<WorkbenchReadFileResult>>(null)
  const [editorContent, setEditorContent] = useState('')
  const [openTabsByPath, setOpenTabsByPath] = useState<Map<string, WorkbenchOpenEditorTab>>(
    () => new Map()
  )
  const [isSavingFile, setIsSavingFile] = useState(false)
  const [saveRevision, setSaveRevision] = useState(0)
  // 工作区在编辑器之外被改动的次数：Agent 写了文件、磁盘监听送到了事件、窗口回到前台重读了磁盘。
  // 编辑器与问题面板据此重算诊断——当前文档没变时也要，错误可能已经在依赖文件里修好。
  const [externalRevision, setExternalRevision] = useState(0)
  const externalChangeNoticeKeysRef = useRef(new Set<string>())
  const externalFileRefreshInFlightRef = useRef(false)
  const externalFileRefreshQueuedRef = useRef(false)
  const openedFileSnapshotsRef = useRef<WorkbenchOpenFileSnapshot[]>([])
  const pendingFilePathRef = useRef<Nullable<string>>(null)
  const timers = useTimerScope('useWorkbenchEditorController')
  const { abandonInFlightRequests, completeIfActive, isActive, start } = useMonotonicAsyncRequest()
  const selectedFilePathRef = useLatest(selectedFilePath)
  const openTabsByPathLatest = useLatest(openTabsByPath)
  const activeProjectRef = useLatest(activeProject)
  const onFileMetadataSavedLatest = useLatest(onFileMetadataSaved)
  const onFileSavedLatest = useLatest(onFileSaved)
  const onExternalFilesChangedLatest = useLatest(onExternalFilesChanged)
  // 每个文件的写盘排成一队（值是这条队的尾巴）：同一文件的两次写盘不并发，后一次以前一次存下的快照为准。
  const saveChainsRef = useRef(new Map<string, Promise<unknown>>())
  // 每个文件最近几次写盘「从哪个快照存成了哪个」，见 resolveWorkbenchEditorSaveBase。
  const savedSnapshotTrailsRef = useRef(new Map<string, WorkbenchEditorSavedSnapshot[]>())
  // 进行中的手动保存（单个或批量）数；isSavingFile 只在全部结束后才落回 false。
  const manualSaveCountRef = useRef(0)

  const hasUnsavedChanges =
    !!selectedFile
    && !selectedFile.imagePreview
    && (
      editorContent !== selectedFile.content
      || !!openTabsByPath.get(selectedFile.path)?.textConversion
    )
  const hasUnsavedOpenTabs = useMemo(
    () => [...openTabsByPath.values()].some(isDirtyTab),
    [openTabsByPath]
  )
  // 用户为每个文件选过的编辑模式；没选过的按 resolveWorkbenchEditorEditMode 的默认规则。
  const [chosenEditModes, setChosenEditModes] = useState<ReadonlyMap<string, WorkbenchEditorEditMode>>(
    () => new Map()
  )
  const selectedFileEditMode: Nullable<WorkbenchEditorEditMode> = selectedFile
    ? resolveWorkbenchEditorEditMode(selectedFile, chosenEditModes.get(selectedFile.path))
    : null
  const canEditSelectedFile =
    !!selectedFile && isWorkbenchFileEditable(selectedFile, chosenEditModes.get(selectedFile.path))
  const openTabs = useMemo(() => [...openTabsByPath.values()], [openTabsByPath])
  const openedFileSnapshots = useMemo(() => {
    const snapshots = reuseWorkbenchOpenFileSnapshots(openedFileSnapshotsRef.current, openTabs)
    openedFileSnapshotsRef.current = snapshots
    return snapshots
  }, [openTabs])

  function rememberOpenFile(
    file: WorkbenchReadFileResult,
    content: string,
    { keepTextConversion = true }: { keepTextConversion?: boolean } = {}
  ): void {
    setOpenTabsByPath((current) => {
      const next = new Map(current)
      const currentTab = current.get(file.path)
      const sameSnapshot = !!currentTab && !hasFileSnapshotChanged(currentTab.file, file)
      const externalChange = optionalWhenLazy(sameSnapshot, () => currentTab!.externalChange)
      // 选过的格式转换跟着编辑缓冲走，直到存下去或还原；上次保存被拒的说明内容一改就作废。
      const textConversion = optionalWhenLazy(
        sameSnapshot && keepTextConversion,
        () => currentTab!.textConversion
      )
      next.set(file.path, {
        path: file.path,
        file,
        content,
        textConversion,
        externalChange,
      })
      return next
    })
  }

  /**
   * 只改标签正文，不动标签手里的磁盘快照。保存刚写完、新快照还没提交时，调用方闭包里的文件对象还是
   * 保存前那份；拿它整个覆盖回去，下一次保存和磁盘比对都会把刚写下的版本误报成「外部修改」。
   * 选过的格式转换跟着正文走；上次保存被拒的说明针对的是旧正文，一改就作废。
   */
  function updateOpenTabContent(file: WorkbenchReadFileResult, content: string): void {
    setOpenTabsByPath((current) => {
      const currentTab = current.get(file.path)
      if (currentTab?.content === content) return current

      return new Map(current).set(
        file.path,
        currentTab
          ? { ...currentTab, content, unencodableSaveError: undefined }
          : { path: file.path, file, content }
      )
    })
  }

  const updateEditorContent = useMemoizedFn((content: string): void => {
    if (!selectedFile || !isWorkbenchFileEditable(selectedFile, chosenEditModes.get(selectedFile.path)))
      return

    setEditorContent(content)
    updateOpenTabContent(selectedFile, content)
  })

  const applyLanguageServiceFileChanges = useMemoizedFn(
    (changes: readonly WorkbenchLanguageServiceFileEdit[]): void => {
      if (isEmpty(changes)) return

      for (const change of changes) {
        const tab = openTabsByPathLatest.current.get(change.path)
        // 只读的文件不接跨文件改名重构的改动。
        if (
          !tab
          || !isWorkbenchFileEditable(tab.file, chosenEditModes.get(tab.path))
          || isEmpty(change.edits)
        ) continue

        const nextContent = applyWorkbenchLanguageServiceEditsToContent(tab.content, change.edits)
        updateOpenTabContent(tab.file, nextContent)
        if (selectedFilePathRef.current === change.path) {
          setEditorContent(nextContent)
        }
      }
    }
  )

  function warnUnsavedChanges(): void {
    messageLatest.current.warning({
      title: tLatest.current('workbench.unsavedChangesTitle'),
      description: tLatest.current('workbench.unsavedChangesDescription'),
    })
  }

  function shouldRefreshOpenFilesForWorkspaceEvent(
    event: SystemWorkspaceFilesChangedEvent
  ): boolean {
    const tabs = [...openTabsByPathLatest.current.values()]
    if (isEmpty(tabs) || isEmpty(event.paths)) return false

    return tabs.some((tab) =>
      event.paths.some(
        (path) =>
          path === tab.path ||
          isSameOrChildPath(path, tab.path) ||
          isSameOrChildPath(tab.path, path)
      )
    )
  }

  function warnExternalFileChanged(tab: WorkbenchOpenEditorTab): void {
    const change = tab.externalChange
    if (!change) return

    messageLatest.current.warning({
      title:
        change.status === 'modified'
          ? tLatest.current('workbench.externalFileChangedTitle')
          : change.status === 'deleted'
            ? tLatest.current('workbench.externalFileDeletedTitle')
            : tLatest.current('workbench.externalFileUnavailableTitle'),
      description:
        change.status === 'modified'
          ? tLatest.current('workbench.externalFileChangedDescription', { path: tab.path })
          : change.status === 'deleted'
            ? tLatest.current(
                tab.file.imagePreview
                  ? 'workbench.externalImageDeletedDescription'
                  : 'workbench.externalFileDeletedDescription',
                { path: tab.path }
              )
            : tLatest.current('workbench.externalFileUnavailableDescription', { path: tab.path }),
    })
  }

  function rememberUnencodableSaveError(tab: WorkbenchOpenEditorTab, message: string): void {
    setOpenTabsByPath((current) => {
      const currentTab = current.get(tab.path)
      // 保存期间用户又改了内容：说明针对的是旧内容，不再挂到标签上。
      if (!currentTab || currentTab.content !== tab.content) return current

      return new Map(current).set(tab.path, { ...currentTab, unencodableSaveError: message })
    })
  }

  function notifyExternalFileChangedOnce(
    path: string,
    change: WorkbenchOpenEditorExternalChange,
    isImagePreview: boolean
  ): void {
    const key = buildExternalChangeNoticeKey(path, change)
    if (externalChangeNoticeKeysRef.current.has(key)) return

    externalChangeNoticeKeysRef.current.add(key)
    messageLatest.current.warning({
      title:
        change.status === 'modified'
          ? tLatest.current('workbench.externalFileChangedTitle')
          : change.status === 'deleted'
            ? tLatest.current('workbench.externalFileDeletedTitle')
            : tLatest.current('workbench.externalFileUnavailableTitle'),
      description:
        change.status === 'modified'
          ? tLatest.current('workbench.externalFileChangedDescription', { path })
          : change.status === 'deleted'
            ? tLatest.current(
                isImagePreview
                  ? 'workbench.externalImageDeletedDescription'
                  : 'workbench.externalFileDeletedDescription',
                { path }
              )
            : tLatest.current('workbench.externalFileUnavailableDescription', { path }),
    })
  }

  const ensureNoUnsavedChanges = useMemoizedFn((): boolean => {
    if (!hasUnsavedOpenTabs) return true

    warnUnsavedChanges()
    return false
  })

  const ensureNoUnsavedFilesInPath = useMemoizedFn((path: string): boolean => {
    const hasAffectedDirtyTab = [...openTabsByPath.values()].some(
      (tab) => isDirtyTab(tab) && isSameOrChildPath(tab.path, path)
    )
    if (!hasAffectedDirtyTab) return true

    warnUnsavedChanges()
    return false
  })

  const resetSelectedFile = useMemoizedFn((): void => {
    abandonInFlightRequests()
    externalChangeNoticeKeysRef.current.clear()
    setSelectedFilePath(null)
    setSelectedFile(null)
    setEditorContent('')
    setOpenTabsByPath(new Map())
    setChosenEditModes(new Map())
    pendingFilePathRef.current = null
  })

  /** 在只读与编辑之间切换当前文件；没有完整文本的文件（图片、截断的大文件）不能切到编辑。 */
  const toggleSelectedFileEditMode = useMemoizedFn((): void => {
    if (!selectedFile || !selectedFileEditMode || !canEditWorkbenchFileContent(selectedFile)) return

    const nextMode: WorkbenchEditorEditMode = selectedFileEditMode === 'edit' ? 'read-only' : 'edit'
    setChosenEditModes((current) => new Map(current).set(selectedFile.path, nextMode))
  })

  const revertSelectedFile = useMemoizedFn((): void => {
    if (!selectedFile) return

    setEditorContent(selectedFile.content)
    rememberOpenFile(selectedFile, selectedFile.content, { keepTextConversion: false })
  })

  const selectFile = useMemoizedFn(
    async (path: string, options: WorkbenchFileOpenOptions = {}): Promise<void> => {
      if (!activeProject) return

      if (path === selectedFilePath) {
        if (pendingFilePathRef.current) {
          abandonInFlightRequests()
          pendingFilePathRef.current = null
        }
        return
      }
      if (path === pendingFilePathRef.current) return

      const existingTab = openTabsByPath.get(path)
      if (existingTab) {
        abandonInFlightRequests()
        pendingFilePathRef.current = null
        setSelectedFilePath(path)
        setSelectedFile(existingTab.file)
        setEditorContent(existingTab.content)
        return
      }

      const owningProjectId = activeProject.id
      const generation = start()
      pendingFilePathRef.current = path

      try {
        const result = await readWorkbenchEditorFile(activeProject.rootPath, path, 300_000)
        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        // JetBrains 式提交：读取完成前保留当前编辑器；就绪后同一批次提交
        // 选项卡和正文，避免半成品 tab 与“正在读取文件”占位来回闪烁。
        setSelectedFilePath(path)
        setSelectedFile(result)
        setEditorContent(result.content)
        rememberOpenFile(result, result.content)
      } catch (error) {
        const appError = AppError.from(error)
        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        if (!options.quiet) {
          messageLatest.current.error({
            title: tLatest.current('workbench.readFileFailed'),
            description: appError.message,
          })
        }
      } finally {
        completeIfActive(generation, () => {
          if (pendingFilePathRef.current === path) pendingFilePathRef.current = null
        })
      }
    }
  )

  const preloadOpenTab = useMemoizedFn(async (path: string): Promise<boolean> => {
    if (!activeProject || openTabsByPath.has(path)) return true

    try {
      const result = await readWorkbenchEditorFile(
        activeProject.rootPath,
        path,
        EXTERNAL_FILE_READ_MAX_CHARS
      )

      if (activeProjectRef.current?.id !== activeProject.id) return false

      rememberOpenFile(result, result.content)
      return true
    } catch (error) {
      log.debug('恢复 workbench 打开文件失败', { path, error })
      return false
    }
  })

  const restoreEditorSession = useMemoizedFn(
    async ({
      openTabPaths,
      options = {},
      selectedFilePath: nextSelectedFilePath,
    }: {
      openTabPaths: readonly string[]
      options?: WorkbenchFileOpenOptions
      selectedFilePath: Nullable<string>
    }): Promise<void> => {
      if (!activeProject) return

      const pathsToRestore = [...openTabPaths]
      if (nextSelectedFilePath && !pathsToRestore.includes(nextSelectedFilePath)) {
        pathsToRestore.push(nextSelectedFilePath)
      }

      if (isEmpty(pathsToRestore)) return

      for (const path of pathsToRestore) {
        if (path === nextSelectedFilePath) continue
        await preloadOpenTab(path)
      }

      if (nextSelectedFilePath) {
        await selectFile(nextSelectedFilePath, options)
        return
      }

      const firstPath = pathsToRestore[0]
      if (firstPath) {
        await selectFile(firstPath, options)
      }
    }
  )

  const moveOpenEntryPath = useMemoizedFn(
    (previousPath: string, nextPath: string, modifiedAt?: LooseOptional<number>): void => {
      if (!previousPath || previousPath === nextPath) return

      setOpenTabsByPath((current) => {
        const next = new Map<string, WorkbenchOpenEditorTab>()

        for (const tab of current.values()) {
          if (!isSameOrChildPath(tab.path, previousPath)) {
            next.set(tab.path, tab)
            continue
          }

          const movedPath = movePath(tab.path, previousPath, nextPath)
          const movedFile = {
            ...tab.file,
            path: movedPath,
            modifiedAt:
              tab.path === previousPath ? (modifiedAt ?? tab.file.modifiedAt) : tab.file.modifiedAt,
          }
          next.set(movedPath, {
            ...tab,
            path: movedPath,
            file: movedFile,
          })
        }

        return next
      })

      if (selectedFilePath && isSameOrChildPath(selectedFilePath, previousPath)) {
        const nextSelectedPath = movePath(selectedFilePath, previousPath, nextPath)
        setSelectedFilePath(nextSelectedPath)
        setSelectedFile((currentFile) =>
          currentFile
            ? {
                ...currentFile,
                path: nextSelectedPath,
                modifiedAt:
                  selectedFilePath === previousPath
                    ? (modifiedAt ?? currentFile.modifiedAt)
                    : currentFile.modifiedAt,
              }
            : currentFile
        )
      }
    }
  )

  const closeOpenEntryPath = useMemoizedFn((path: string): void => {
    const currentTabs = [...openTabsByPath.values()]
    const remainingTabs = currentTabs.filter((tab) => !isSameOrChildPath(tab.path, path))
    if (remainingTabs.length === currentTabs.length) return

    setOpenTabsByPath(new Map(remainingTabs.map((tab) => [tab.path, tab])))

    if (!selectedFilePath || !isSameOrChildPath(selectedFilePath, path)) return

    const nextSelectedTab = toNullable(remainingTabs[0])
    if (!nextSelectedTab) {
      setSelectedFilePath(null)
      setSelectedFile(null)
      setEditorContent('')
      return
    }

    setSelectedFilePath(nextSelectedTab.path)
    setSelectedFile(nextSelectedTab.file)
    setEditorContent(nextSelectedTab.content)
  })

  const closeOpenFile = useMemoizedFn((path: string): void => {
    const closingTab = openTabsByPath.get(path)
    if (!closingTab) return

    if (isDirtyTab(closingTab)) {
      warnUnsavedChanges()
      return
    }

    const currentTabs = [...openTabsByPath.values()]
    const closingIndex = currentTabs.findIndex((tab) => tab.path === path)
    const remainingTabs = currentTabs.filter((tab) => tab.path !== path)
    setOpenTabsByPath((current) => {
      const next = new Map(current)
      next.delete(path)
      return next
    })

    if (path !== selectedFilePath) return

    const nextSelectedTab = toNullable(
      remainingTabs[Math.max(0, closingIndex - 1)] ?? remainingTabs[0]
    )
    if (!nextSelectedTab) {
      setSelectedFilePath(null)
      setSelectedFile(null)
      setEditorContent('')
      return
    }

    setSelectedFilePath(nextSelectedTab.path)
    setSelectedFile(nextSelectedTab.file)
    setEditorContent(nextSelectedTab.content)
  })

  const closeAllOpenFiles = useMemoizedFn((): void => {
    if (hasUnsavedOpenTabs) {
      warnUnsavedChanges()
      return
    }

    setOpenTabsByPath(new Map())
    setSelectedFilePath(null)
    setSelectedFile(null)
    setEditorContent('')
  })

  const closeUnmodifiedOpenFiles = useMemoizedFn((): void => {
    const dirtyTabs = [...openTabsByPath.values()].filter(isDirtyTab)
    if (dirtyTabs.length === openTabsByPath.size) return

    setOpenTabsByPath(new Map(dirtyTabs.map((tab) => [tab.path, tab])))

    if (selectedFilePath && dirtyTabs.some((tab) => tab.path === selectedFilePath)) return

    const nextSelectedTab = toNullable(dirtyTabs[0])
    if (!nextSelectedTab) {
      setSelectedFilePath(null)
      setSelectedFile(null)
      setEditorContent('')
      return
    }

    setSelectedFilePath(nextSelectedTab.path)
    setSelectedFile(nextSelectedTab.file)
    setEditorContent(nextSelectedTab.content)
  })

  const closeOtherOpenFiles = useMemoizedFn((path: string): void => {
    const targetTab = openTabsByPath.get(path)
    if (!targetTab) return

    const dirtyOtherTab = [...openTabsByPath.values()].find(
      (tab) => tab.path !== path && isDirtyTab(tab)
    )
    if (dirtyOtherTab) {
      warnUnsavedChanges()
      return
    }

    setOpenTabsByPath(new Map([[path, targetTab]]))
    setSelectedFilePath(path)
    setSelectedFile(targetTab.file)
    setEditorContent(targetTab.content)
  })

  const reorderOpenTabs = useMemoizedFn((fromPath: string, toPath: string): void => {
    if (fromPath === toPath) return

    setOpenTabsByPath((current) => {
      const tabs = [...current.values()]
      const fromIndex = tabs.findIndex((tab) => tab.path === fromPath)
      const toIndex = tabs.findIndex((tab) => tab.path === toPath)
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return current

      const [moved] = tabs.splice(fromIndex, 1)
      if (!moved) return current
      tabs.splice(toIndex, 0, moved)
      return new Map(tabs.map((tab) => [tab.path, tab]))
    })
  })

  async function saveTab(
    project: WorkbenchProject,
    tab: WorkbenchOpenEditorTab,
    silent = false
  ): Promise<WorkbenchReadFileResult> {
    return Result.unwrap(
      await workbenchHost.kernel.project.saveWorkbenchFile({
        projectRoot: project.rootPath,
        path: tab.path,
        content: tab.content,
        ...resolveWorkbenchTabTextFormat(tab),
        expectedModifiedAt: tab.file.modifiedAt,
        expectedSize: tab.file.size,
        // 静默自动保存（用户手打）走节流，减少本地历史快照；手动保存始终留快照。
        localHistoryMinIntervalMs: silent ? readWorkbenchLocalHistoryThrottleMs() : 0,
      })
    )
  }

  function applySavedFile(
    saved: WorkbenchReadFileResult,
    savedContent: string,
    options: WorkbenchSaveEditorTabOptions = {}
  ): void {
    setOpenTabsByPath((current) => {
      const currentTab = current.get(saved.path)
      if (!currentTab) return current

      const next = new Map(current)
      next.set(saved.path, {
        path: saved.path,
        file: saved,
        content: currentTab.content === savedContent ? saved.content : currentTab.content,
      })
      return next
    })

    if (selectedFilePathRef.current === saved.path) {
      setSelectedFile(saved)
      // 用函数式更新读取最新 editorContent，避免 useLatest 引用滞后一次按键时，
      // 把保存瞬间的旧内容回灌覆盖用户正在输入的文档（触发整篇 value 同步、光标跳动、补全面板消失）。
      setEditorContent((current) => (current === savedContent ? saved.content : current))
    }

    onFileMetadataSavedLatest.current(saved)
    if (!options.silent) {
      onFileSavedLatest.current()
      setSaveRevision((revision) => revision + 1)
    }
  }

  const refreshOpenFilesFromDisk = useMemoizedFn(async (): Promise<void> => {
    const project = activeProjectRef.current
    const tabs = [...openTabsByPathLatest.current.values()]
    if (!project || isEmpty(tabs)) return

    const owningProjectId = project.id
    const selectedPath = selectedFilePathRef.current
    const selectedIndex = tabs.findIndex((tab) => tab.path === selectedPath)
    if (selectedIndex > 0) tabs.unshift(...tabs.splice(selectedIndex, 1))

    const outcomes: WorkbenchExternalFileReadOutcome[] = []
    // 图片读取会跨 main / IPC / renderer 复制字节；小批并发可避免打开多张大图后，
    // 聚焦窗口或文件事件触发的刷新一次性放大内存峰值。
    for (let index = 0; index < tabs.length; index += EXTERNAL_FILE_REFRESH_CONCURRENCY) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      const batch = await Promise.all(
        tabs.slice(index, index + EXTERNAL_FILE_REFRESH_CONCURRENCY).map(
          async (tab): Promise<WorkbenchExternalFileReadOutcome> => {
            try {
              const diskFile = await readWorkbenchEditorFile(
                project.rootPath,
                tab.path,
                resolveWorkbenchEditorRereadMaxChars(tab.file)
              )
              return {
                path: tab.path,
                baseFile: tab.file,
                diskFile,
                error: null,
              }
            } catch (error) {
              return {
                path: tab.path,
                baseFile: tab.file,
                diskFile: null,
                error: AppError.from(error),
              }
            }
          }
        )
      )
      outcomes.push(...batch)
    }

    if (activeProjectRef.current?.id !== owningProjectId) return

    let changed = false
    let externalDetected = false
    const nextTabs = new Map(openTabsByPathLatest.current)

    for (const outcome of outcomes) {
      const tab = nextTabs.get(outcome.path)
      if (!tab) {
        continue
      }

      if (tab.file !== outcome.baseFile) {
        continue
      }

      if (outcome.diskFile) {
        if (!hasFileSnapshotChanged(tab.file, outcome.diskFile)) {
          if (tab.externalChange) {
            nextTabs.set(tab.path, {
              ...tab,
              externalChange: undefined,
            })
            changed = true
            externalDetected = true
          }
          continue
        }

        externalDetected = true
        if (isDirtyTab(tab)) {
          const externalChange: WorkbenchOpenEditorExternalChange = {
            status: 'modified',
            detectedAt: Date.now(),
            diskFile: outcome.diskFile,
          }
          nextTabs.set(tab.path, {
            ...tab,
            externalChange,
          })
          notifyExternalFileChangedOnce(tab.path, externalChange, !!tab.file.imagePreview)
        } else {
          nextTabs.set(tab.path, {
            ...tab,
            file: outcome.diskFile,
            content: outcome.diskFile.content,
            externalChange: undefined,
          })
          onFileMetadataSavedLatest.current(outcome.diskFile)
        }
        changed = true
        continue
      }

      const externalChange: WorkbenchOpenEditorExternalChange = {
        status: resolveExternalFileUnavailableStatus(outcome.error?.code ?? null),
        detectedAt: Date.now(),
      }
      const currentKey = tab.externalChange
        ? buildExternalChangeNoticeKey(tab.path, tab.externalChange)
        : null
      const nextKey = buildExternalChangeNoticeKey(tab.path, externalChange)
      if (currentKey !== nextKey) {
        nextTabs.set(tab.path, {
          ...tab,
          externalChange,
        })
        notifyExternalFileChangedOnce(tab.path, externalChange, !!tab.file.imagePreview)
        changed = true
      }
      externalDetected = true
    }

    if (!changed) return

    setOpenTabsByPath(nextTabs)
    const selectedTab = selectedPath ? nextTabs.get(selectedPath) : null
    if (selectedTab) {
      setSelectedFile(selectedTab.file)
      setEditorContent(selectedTab.content)
    }

    if (externalDetected) {
      onExternalFilesChangedLatest.current()
      setSaveRevision((revision) => revision + 1)
    }
  })

  const refreshOpenFilesFromDiskLatest = useLatest(refreshOpenFilesFromDisk)
  const noteExternalWorkspaceChange = useMemoizedFn((): void => {
    setExternalRevision((revision) => revision + 1)
  })
  const runRefreshOpenFilesFromDisk = useMemoizedFn((): void => {
    if (document.visibilityState === 'hidden') return
    // 正在刷新时又来了改动（Agent 连着写了第二个文件）：记下来，这一轮读完紧接着再读一轮，不能丢。
    if (externalFileRefreshInFlightRef.current) {
      externalFileRefreshQueuedRef.current = true
      return
    }

    externalFileRefreshInFlightRef.current = true
    void refreshOpenFilesFromDiskLatest.current().finally(() => {
      externalFileRefreshInFlightRef.current = false
      if (!externalFileRefreshQueuedRef.current) return
      externalFileRefreshQueuedRef.current = false
      runRefreshOpenFilesFromDisk()
    })
  })
  const scheduleRefreshOpenFilesFromDisk = useMemo(
    () =>
      timers.debounce(WORKBENCH_EDITOR_FILES_CHANGED_DEBOUNCE_MS, () => {
        runRefreshOpenFilesFromDisk()
      }),
    [runRefreshOpenFilesFromDisk, timers]
  )

  useEffect(
    () => () => scheduleRefreshOpenFilesFromDisk.dispose(),
    [scheduleRefreshOpenFilesFromDisk]
  )

  const reloadOpenFileFromDisk = useMemoizedFn(async (path: string): Promise<void> => {
    const project = activeProjectRef.current
    if (!project) return

    const owningProjectId = project.id
    try {
      const diskFile = await readWorkbenchEditorFile(
        project.rootPath,
        path,
        resolveWorkbenchEditorRereadMaxChars(openTabsByPathLatest.current.get(path)?.file)
      )
      if (activeProjectRef.current?.id !== owningProjectId) return

      setOpenTabsByPath((current) => {
        if (!current.has(path)) return current

        const next = new Map(current)
        next.set(path, {
          path,
          file: diskFile,
          content: diskFile.content,
        })
        return next
      })
      if (selectedFilePathRef.current === path) {
        setSelectedFile(diskFile)
        setEditorContent(diskFile.content)
      }
      onFileMetadataSavedLatest.current(diskFile)
      onExternalFilesChangedLatest.current()
      setSaveRevision((revision) => revision + 1)
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.readFileFailed'),
        description: appError.message,
      })
    }
  })

  const restoreDeletedOpenFile = useMemoizedFn(async (path: string): Promise<void> => {
    const project = activeProjectRef.current
    const tab = openTabsByPathLatest.current.get(path)
    if (!project || !tab || tab.file.imagePreview || tab.externalChange?.status !== 'deleted') return

    const owningProjectId = project.id
    beginManualSave()
    try {
      const restoredFile = Result.unwrap(
        await workbenchHost.kernel.project.restoreMissingWorkbenchFile({
          projectRoot: project.rootPath,
          path,
          content: tab.content,
          ...resolveWorkbenchTabTextFormat(tab),
        })
      )
      if (activeProjectRef.current?.id !== owningProjectId) return

      applySavedFile(restoredFile, tab.content)
      onExternalFilesChangedLatest.current()
      messageLatest.current.success({
        title: tLatest.current('workbench.restoreDeletedFileSucceeded'),
      })
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.restoreDeletedFileFailed'),
        description: appError.message,
      })
    } finally {
      endManualSave()
    }
  })

  const keepLocalVersionForExternalConflict = useMemoizedFn((path: string): void => {
    const tab = openTabsByPathLatest.current.get(path)
    const diskFile = tab?.externalChange?.diskFile
    if (!tab || !diskFile) return

    setOpenTabsByPath((current) => {
      const currentTab = current.get(path)
      if (!currentTab) return current

      const next = new Map(current)
      next.set(path, {
        ...currentTab,
        file: diskFile,
        // 保留本地草稿也保留它的格式：外部改了编码或换行符时，下一次保存按草稿的格式写回。
        textConversion: resolveWorkbenchTextConversion(
          diskFile,
          resolveWorkbenchTabTextFormat(currentTab)
        ),
        externalChange: undefined,
      })
      return next
    })

    if (selectedFilePathRef.current === path) {
      setSelectedFile(diskFile)
    }

    onFileMetadataSavedLatest.current(diskFile)
    onExternalFilesChangedLatest.current()
  })

  const resolveSelectedExternalFileConflict = useMemoizedFn(
    async (resolution: 'external' | 'local'): Promise<void> => {
      const path = selectedFilePathRef.current
      if (!path) return

      if (resolution === 'external') {
        if (openTabsByPathLatest.current.get(path)?.externalChange?.status === 'deleted') {
          await restoreDeletedOpenFile(path)
          return
        }
        await reloadOpenFileFromDisk(path)
        return
      }

      keepLocalVersionForExternalConflict(path)
    }
  )

  useEffect(() => {
    if (!activeProject) return undefined

    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'hidden') return

      // 不在前台的这段时间里磁盘上发生的改动没有重算过诊断，回来时补一次。
      noteExternalWorkspaceChange()
      void refreshOpenFilesFromDisk()
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        refreshIfVisible()
      }
    }

    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return (): void => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activeProject, noteExternalWorkspaceChange, refreshOpenFilesFromDisk])

  useWorkspaceFilesChangedRefresh({
    rootPath: activeProject?.rootPath,
    enabled: !!activeProject,
    onChanged: (event) => {
      if (document.visibilityState === 'hidden') return
      if (mayAffectWorkbenchDiagnostics(event)) noteExternalWorkspaceChange()
      if (!shouldRefreshOpenFilesForWorkspaceEvent(event)) return

      if (getWorkbenchEditorFilesChangedRefreshDelayMs(event) <= 0) {
        scheduleRefreshOpenFilesFromDisk.cancel()
        runRefreshOpenFilesFromDisk()
        return
      }

      scheduleRefreshOpenFilesFromDisk()
    },
  })

  // Agent（含子 Agent、外部引擎）写了项目文件：不等文件监听——macOS 在机器忙的时候把事件攒上好几秒才送到，
  // 而 Agent 跑构建时正是最忙的时候——工具结果一到就重读打开的文件、重算诊断。监听随后送到的事件照常处理，
  // 多刷一次是幂等的。
  const activeProjectRootPath = activeProject?.rootPath
  useEffect(() => {
    if (!activeProjectRootPath) return undefined

    return subscribeWorkbenchAgentProjectWrites(activeProjectRootPath, () => {
      if (document.visibilityState === 'hidden') return
      noteExternalWorkspaceChange()
      scheduleRefreshOpenFilesFromDisk.cancel()
      runRefreshOpenFilesFromDisk()
    })
  }, [
    activeProjectRootPath,
    noteExternalWorkspaceChange,
    runRefreshOpenFilesFromDisk,
    scheduleRefreshOpenFilesFromDisk,
  ])

  /** 同一文件的写盘排队进行；不同文件互不等待。 */
  function runSerializedSave<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = saveChainsRef.current.get(path) ?? Promise.resolve()
    const next = previous.then(task, task)
    saveChainsRef.current.set(path, next)
    const release = (): void => {
      if (saveChainsRef.current.get(path) === next) saveChainsRef.current.delete(path)
    }
    next.then(release, release)
    return next
  }

  function beginManualSave(): void {
    manualSaveCountRef.current += 1
    setIsSavingFile(true)
  }

  function endManualSave(): void {
    manualSaveCountRef.current = Math.max(0, manualSaveCountRef.current - 1)
    if (manualSaveCountRef.current === 0) setIsSavingFile(false)
  }

  /** 手动保存落盘后的通知：刷新校验状态、项目索引与依赖保存序号的视图（自动保存不发）。 */
  function notifyFilesSaved(): void {
    onFileSavedLatest.current()
    setSaveRevision((revision) => revision + 1)
  }

  /**
   * 把一个标签写回磁盘，写好就把新快照落进状态（不发保存通知、不弹提示，交给调用方）。
   * 同一文件的写盘排队；静默的自动保存碰上同一文件正在写就跳过，下一轮再来。
   */
  const writeEditorTab = useMemoizedFn(
    (
      requestedTab: WorkbenchOpenEditorTab,
      options: WorkbenchSaveEditorTabOptions = {}
    ): Promise<WorkbenchEditorSaveResult> => {
      if (options.silent && saveChainsRef.current.has(requestedTab.path))
        return Promise.resolve({ status: 'skipped' })

      return runSerializedSave(requestedTab.path, async (): Promise<WorkbenchEditorSaveResult> => {
        const project = activeProjectRef.current
        const trail = savedSnapshotTrailsRef.current.get(requestedTab.path) ?? []
        const baseFile = resolveWorkbenchEditorSaveBase(requestedTab.file, trail)
        const tab = baseFile === requestedTab.file ? requestedTab : { ...requestedTab, file: baseFile }
        // 只读只挡输入：切到只读之前已经改下的内容照样能保存。
        if (
          !project
          || !canSaveWorkbenchTabContent(tab)
          || !isDirtyTab(tab)
        )
          return { status: 'skipped' }

        const latestTab = openTabsByPathLatest.current.get(tab.path)
        // 内容里有文件编码写不出的字符：改之前不再自动保存（结果只会一样）。
        if (options.silent && latestTab?.unencodableSaveError) return { status: 'skipped' }
        const externalChange = latestTab?.externalChange ?? tab.externalChange
        if (externalChange) return { status: 'conflict', change: externalChange }

        try {
          const saved = await saveTab(project, tab, options.silent)
          savedSnapshotTrailsRef.current.set(
            tab.path,
            appendWorkbenchEditorSavedSnapshot(trail, { base: tab.file, saved })
          )
          if (activeProjectRef.current?.id !== project.id) return { status: 'skipped' }

          applySavedFile(saved, tab.content, { silent: true })
          return { status: 'saved', file: saved }
        } catch (error) {
          const appError = AppError.from(error)
          if (appError.code === WorkbenchUnencodableTextErrorCode) {
            // 编辑区据此提示并提供「转换为 UTF-8」；自动保存失败时也要让用户看到。
            rememberUnencodableSaveError(tab, appError.message)
          }
          return { status: 'failed', error: appError }
        }
      })
    }
  )

  /** 保存一个标签。手动保存提示冲突与失败；静默的自动保存只返回结果，由自动保存自己记账和提示。 */
  const saveEditorTab = useMemoizedFn(
    async (
      tab: WorkbenchOpenEditorTab,
      options: WorkbenchSaveEditorTabOptions = {}
    ): Promise<WorkbenchEditorSaveResult> => {
      if (!activeProject) return { status: 'skipped' }

      const owningProjectId = activeProject.id
      if (!options.silent) beginManualSave()
      try {
        const result = await writeEditorTab(tab, options)
        if (options.silent || activeProjectRef.current?.id !== owningProjectId) return result

        switch (result.status) {
          case 'saved': {
            notifyFilesSaved()
            if (options.notify) {
              messageLatest.current.success({
                title: tLatest.current('workbench.saveSucceeded'),
              })
            }
            break
          }
          case 'conflict': {
            warnExternalFileChanged({ ...tab, externalChange: result.change })
            break
          }
          case 'failed': {
            messageLatest.current.error({
              title: tLatest.current('workbench.saveFileFailed'),
              description: result.error.message,
            })
            break
          }
        }
        return result
      } finally {
        if (!options.silent) endManualSave()
      }
    }
  )

  /**
   * 逐个保存一批标签，每存好一个就把它的新快照落进状态：中途哪个失败了，前面已经写下的文件也不会
   * 留着旧快照、在之后被当成外部修改。全部结束后统一发一次保存通知。
   */
  const saveEditorTabs = useMemoizedFn(
    async (
      tabs: readonly WorkbenchOpenEditorTab[]
    ): Promise<Map<string, WorkbenchEditorSaveResult>> => {
      const results = new Map<string, WorkbenchEditorSaveResult>()
      const owningProjectId = activeProjectRef.current?.id
      if (!owningProjectId || isEmpty(tabs)) return results

      beginManualSave()
      try {
        for (const tab of tabs) {
          results.set(tab.path, await writeEditorTab(tab))
          if (activeProjectRef.current?.id !== owningProjectId) break
        }
      } finally {
        endManualSave()
      }
      if (
        activeProjectRef.current?.id === owningProjectId
        && [...results.values()].some((result) => result.status === 'saved')
      )
        notifyFilesSaved()
      return results
    }
  )

  const autosaveFailures = useWorkbenchEditorAutosave({
    activeProject,
    isSavingFile,
    openTabsByPath,
    saveEditorTab,
    onAutosaveFailed: (path, message) => {
      messageLatest.current.error({
        title: tLatest.current('workbench.autosaveFailedTitle'),
        description: tLatest.current('workbench.saveFileFailedDescription', {
          path,
          reason: message,
        }),
      })
    },
  })

  const saveSelectedFile = useMemoizedFn(async (): Promise<void> => {
    if (!selectedFile || !hasUnsavedChanges) return

    await saveEditorTab(
      {
        path: selectedFile.path,
        file: selectedFile,
        content: editorContent,
        textConversion: openTabsByPath.get(selectedFile.path)?.textConversion,
        externalChange: openTabsByPath.get(selectedFile.path)?.externalChange,
      },
      { notify: true }
    )
  })

  /**
   * 用户明确选的格式转换（转换为 UTF-8、换换行符）：记到当前标签上（算未保存）并立即保存。
   * 与磁盘上的格式一样又能原样写回时只是撤掉之前没存下去的转换。
   */
  const convertSelectedFileTextFormat = useMemoizedFn(
    async (format: WorkbenchTextFormat): Promise<void> => {
      const path = selectedFilePathRef.current
      const tab = path ? openTabsByPathLatest.current.get(path) : undefined
      if (!tab || tab.file.imagePreview || tab.file.truncated) return

      const textConversion = resolveWorkbenchTextConversion(tab.file, format)
      setOpenTabsByPath((current) => {
        const currentTab = current.get(tab.path)
        return currentTab
          ? new Map(current).set(tab.path, {
              ...currentTab,
              textConversion,
              unencodableSaveError: undefined,
            })
          : current
      })
      await saveEditorTab(
        { ...tab, textConversion, unencodableSaveError: undefined },
        { notify: true }
      )
    }
  )

  /** 一批保存里存不下的文件逐个提示：外部改过的提示先处理冲突，写盘失败的带上路径与原因。 */
  function reportUnsavedResults(summary: WorkbenchEditorSaveSummary): void {
    for (const { path, change } of summary.conflicts) {
      const tab = openTabsByPathLatest.current.get(path)
      if (tab) warnExternalFileChanged({ ...tab, externalChange: change })
    }
    for (const { path, error } of summary.failures) {
      messageLatest.current.error({
        title: tLatest.current('workbench.saveFileFailed'),
        description: tLatest.current('workbench.saveFileFailedDescription', {
          path,
          reason: error.message,
        }),
      })
    }
  }

  /**
   * 保存全部已修改的标签。每个文件各存各的：一个文件外部改过或写不进去，不挡其它文件；
   * 存好的文件只在正文仍是保存那一刻的内容时才换成磁盘版本，保存期间接着打的字不会被冲掉。
   */
  const saveAllOpenFiles = useMemoizedFn(async (): Promise<void> => {
    if (!activeProject) return

    const owningProjectId = activeProject.id
    const dirtyTabs = [...openTabsByPath.values()].filter(
      (tab) => canSaveWorkbenchTabContent(tab) && isDirtyTab(tab)
    )
    if (isEmpty(dirtyTabs)) return

    const summary = summarizeWorkbenchEditorSaveResults(await saveEditorTabs(dirtyTabs))
    if (activeProjectRef.current?.id !== owningProjectId) return

    if (!isEmpty(summary.savedPaths)) {
      messageLatest.current.success({
        title: tLatest.current('workbench.saveAllSucceeded', { count: summary.savedPaths.length }),
      })
    }
    reportUnsavedResults(summary)
  })

  return {
    selectedFilePath,
    selectedFile,
    editorContent,
    hasUnsavedChanges,
    hasUnsavedOpenTabs,
    canEditSelectedFile,
    selectedFileEditMode,
    toggleSelectedFileEditMode,
    openTabs,
    openedFileSnapshots,
    isSavingFile,
    /** 自动保存存不下的文件与原因（按路径）；存好、撤回或关掉标签后撤销。 */
    autosaveFailures,
    saveRevision,
    externalRevision,
    setEditorContent: updateEditorContent,
    applyLanguageServiceFileChanges,
    ensureNoUnsavedChanges,
    ensureNoUnsavedFilesInPath,
    resetSelectedFile,
    revertSelectedFile,
    selectFile,
    preloadOpenTab,
    restoreEditorSession,
    closeOpenFile,
    closeOtherOpenFiles,
    closeAllOpenFiles,
    closeUnmodifiedOpenFiles,
    reorderOpenTabs,
    moveOpenEntryPath,
    closeOpenEntryPath,
    saveSelectedFile,
    saveAllOpenFiles,
    convertSelectedFileTextFormat,
    resolveSelectedExternalFileConflict,
  }
}
