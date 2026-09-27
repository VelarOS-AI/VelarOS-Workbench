import { useEffect, useMemo, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import { applyWorkbenchLanguageServiceEditsToContent } from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import { isWorkbenchEditorTabAutosavable } from '@renderer/models/editor/workbenchEditorAutosave'
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
  collectWorkbenchEditorTabsToRight,
  collectWorkbenchEditorUnsavedAfterFlush,
  popWorkbenchClosedEditorTab,
  pushWorkbenchClosedEditorTabs,
  resolveWorkbenchEditorSelectionAfterClose,
  type WorkbenchEditorCloseChoice,
  type WorkbenchEditorCloseRequest,
  type WorkbenchEditorWindowCloseReason,
} from '@renderer/models/editor/workbenchEditorTabClose'
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
  // 等用户回答「保存 / 不保存 / 取消」的那次关闭；同一时间只问一个。
  const [closeRequest, setCloseRequest] = useState<Nullable<WorkbenchEditorCloseRequest>>(null)
  const [isResolvingCloseRequest, setIsResolvingCloseRequest] = useState(false)
  const closeRequestSeqRef = useRef(0)
  const answeredCloseRequestIdRef = useRef<Nullable<number>>(null)
  // 关窗确认的答复要交回主进程：用户答了（或替他存好了）就用它把结果送出去。
  const windowCloseSettleRef = useRef<Nullable<(proceed: boolean) => void>>(null)
  const windowCloseDecisionRef = useRef<Nullable<Promise<boolean>>>(null)
  // 最近关掉的标签（最近关的在末尾），「重新打开关闭的标签」从这里取。
  const closedTabPathsRef = useRef<string[]>([])

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

  function rememberOpenFile(file: WorkbenchReadFileResult, content: string): void {
    setOpenTabsByPath((current) => {
      const next = new Map(current)
      const currentTab = current.get(file.path)
      const sameSnapshot = !!currentTab && !hasFileSnapshotChanged(currentTab.file, file)
      const externalChange = optionalWhenLazy(sameSnapshot, () => currentTab!.externalChange)
      // 选过的格式转换跟着编辑缓冲走，直到存下去或还原（见 revertOpenFiles）；上次保存被拒的说明
      // 内容一改就作废。
      const textConversion = optionalWhenLazy(sameSnapshot, () => currentTab!.textConversion)
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
    closedTabPathsRef.current = []
  })

  /** 在只读与编辑之间切换当前文件；没有完整文本的文件（图片、截断的大文件）不能切到编辑。 */
  const toggleSelectedFileEditMode = useMemoizedFn((): void => {
    if (!selectedFile || !selectedFileEditMode || !canEditWorkbenchFileContent(selectedFile)) return

    const nextMode: WorkbenchEditorEditMode = selectedFileEditMode === 'edit' ? 'read-only' : 'edit'
    setChosenEditModes((current) => new Map(current).set(selectedFile.path, nextMode))
  })

  /**
   * 放弃这些标签里没保存的改动，回到磁盘上的版本；磁盘上已经被外部改过的，直接换成外部那一份。
   * 标签留着，只是不再有改动。
   */
  const revertOpenFiles = useMemoizedFn((paths: readonly string[]): void => {
    const revertedTabs = paths.flatMap((path): WorkbenchOpenEditorTab[] => {
      const tab = openTabsByPath.get(path)
      if (!tab || !isDirtyTab(tab)) return []

      // 选过的格式转换与上次保存被拒的说明也一并放弃。
      const diskFile = tab.externalChange?.status === 'modified' ? tab.externalChange.diskFile : null
      return [
        diskFile
          ? { path, file: diskFile, content: diskFile.content }
          : {
              ...tab,
              content: tab.file.content,
              textConversion: undefined,
              unencodableSaveError: undefined,
            },
      ]
    })
    if (isEmpty(revertedTabs)) return

    setOpenTabsByPath((current) => {
      const next = new Map(current)
      for (const tab of revertedTabs) {
        if (next.has(tab.path)) next.set(tab.path, tab)
      }
      return next
    })
    const selectedTab = revertedTabs.find((tab) => tab.path === selectedFilePathRef.current)
    if (selectedTab) {
      setSelectedFile(selectedTab.file)
      setEditorContent(selectedTab.content)
    }
    const adoptedDiskFiles = revertedTabs.filter((tab) => tab.file !== openTabsByPath.get(tab.path)?.file)
    if (!isEmpty(adoptedDiskFiles)) {
      adoptedDiskFiles.forEach((tab) => onFileMetadataSavedLatest.current(tab.file))
      onExternalFilesChangedLatest.current()
    }
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

  /** 真正关掉这些标签（不再过问未保存改动），关的是当前标签时按关闭前的顺序选好下一个。 */
  const commitCloseOpenFiles = useMemoizedFn((paths: readonly string[]): void => {
    const closingPaths = new Set(paths.filter((path) => openTabsByPath.has(path)))
    if (closingPaths.size === 0) return

    const nextSelectedPath = resolveWorkbenchEditorSelectionAfterClose(
      [...openTabsByPath.keys()],
      closingPaths,
      selectedFilePath
    )
    setOpenTabsByPath((current) => {
      const next = new Map(current)
      closingPaths.forEach((path) => next.delete(path))
      return next
    })
    closingPaths.forEach((path) => savedSnapshotTrailsRef.current.delete(path))
    closedTabPathsRef.current = pushWorkbenchClosedEditorTabs(
      closedTabPathsRef.current,
      [...openTabsByPath.keys()].filter((path) => closingPaths.has(path))
    )

    if (nextSelectedPath === selectedFilePath) return

    const nextSelectedTab = nextSelectedPath ? openTabsByPath.get(nextSelectedPath) : null
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

  /**
   * 关掉一批标签。都没有未保存改动就直接关；有的话先问一次「保存 / 不保存 / 取消」，
   * 列出所有有改动的文件，等用户回答（见 resolveCloseRequest）。
   */
  const requestCloseOpenFiles = useMemoizedFn((paths: readonly string[]): void => {
    const targetPaths = paths.filter((path) => openTabsByPath.has(path))
    if (isEmpty(targetPaths)) return

    const dirtyPaths = targetPaths.filter((path) => isDirtyTab(openTabsByPath.get(path)!))
    if (isEmpty(dirtyPaths)) {
      commitCloseOpenFiles(targetPaths)
      return
    }
    // 已经在问了（连按了两次关闭）：先把这一次答完。
    if (closeRequest) return

    closeRequestSeqRef.current += 1
    setCloseRequest({
      id: closeRequestSeqRef.current,
      kind: 'tabs',
      paths: targetPaths,
      dirtyPaths,
    })
  })

  const closeOpenFile = useMemoizedFn((path: string): void => {
    requestCloseOpenFiles([path])
  })

  const closeAllOpenFiles = useMemoizedFn((): void => {
    requestCloseOpenFiles([...openTabsByPath.keys()])
  })

  const closeUnmodifiedOpenFiles = useMemoizedFn((): void => {
    commitCloseOpenFiles(openTabs.filter((tab) => !isDirtyTab(tab)).map((tab) => tab.path))
  })

  const closeOtherOpenFiles = useMemoizedFn((path: string): void => {
    if (!openTabsByPath.has(path)) return

    requestCloseOpenFiles([...openTabsByPath.keys()].filter((openPath) => openPath !== path))
  })

  const closeOpenFilesToRight = useMemoizedFn((path: string): void => {
    requestCloseOpenFiles(collectWorkbenchEditorTabsToRight([...openTabsByPath.keys()], path))
  })

  /** 取出最近关掉、此刻没打开着的那个标签的路径（取出就不再记着）；没有返回 null。 */
  const takeRecentlyClosedTabPath = useMemoizedFn((): Nullable<string> => {
    const { path, stack } = popWorkbenchClosedEditorTab(
      closedTabPathsRef.current,
      new Set(openTabsByPathLatest.current.keys())
    )
    closedTabPathsRef.current = stack
    return path
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
      const result = await restoreDeletedTab(tab)
      if (activeProjectRef.current?.id !== owningProjectId) return

      if (result.status === 'saved') {
        notifyFilesSaved()
        onExternalFilesChangedLatest.current()
        messageLatest.current.success({
          title: tLatest.current('workbench.restoreDeletedFileSucceeded'),
        })
      } else if (result.status === 'failed') {
        messageLatest.current.error({
          title: tLatest.current('workbench.restoreDeletedFileFailed'),
          description: result.error.message,
        })
      }
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

  /** 把磁盘上已经被删掉的文件按标签里的内容重新建出来（与写盘同一条队，落状态、不提示）。 */
  const restoreDeletedTab = useMemoizedFn(
    (tab: WorkbenchOpenEditorTab): Promise<WorkbenchEditorSaveResult> =>
      runSerializedSave(tab.path, async (): Promise<WorkbenchEditorSaveResult> => {
        const project = activeProjectRef.current
        if (!project) return { status: 'skipped' }

        try {
          const restoredFile = Result.unwrap(
            await workbenchHost.kernel.project.restoreMissingWorkbenchFile({
              projectRoot: project.rootPath,
              path: tab.path,
              content: tab.content,
              ...resolveWorkbenchTabTextFormat(tab),
            })
          )
          if (activeProjectRef.current?.id !== project.id) return { status: 'skipped' }

          applySavedFile(restoredFile, tab.content, { silent: true })
          return { status: 'saved', file: restoredFile }
        } catch (error) {
          return { status: 'failed', error: AppError.from(error) }
        }
      })
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

  const autosaveHeldPaths = useMemo(
    () => new Set(closeRequest?.dirtyPaths ?? []),
    [closeRequest]
  )
  const { failures: autosaveFailures, skipExitFlush } = useWorkbenchEditorAutosave({
    activeProject,
    isSavingFile,
    heldPaths: autosaveHeldPaths,
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

  /**
   * 保存当前文件。`content` 是编辑器这一刻的正文：在编辑区里按 ⌘S 时刚格式化、收拾过空白，标签里的正文要等
   * 下一次渲染才跟上；不给就用标签里的。
   */
  const saveSelectedFile = useMemoizedFn(async (content?: string): Promise<void> => {
    if (!selectedFile) return
    const tab = openTabsByPath.get(selectedFile.path)
    const nextContent = content ?? editorContent
    if (!isDirtyTab({ file: selectedFile, content: nextContent, textConversion: tab?.textConversion }))
      return

    await saveEditorTab(
      {
        path: selectedFile.path,
        file: selectedFile,
        content: nextContent,
        textConversion: tab?.textConversion,
        externalChange: tab?.externalChange,
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

  /**
   * 关闭前按「保存」存这些标签：磁盘上已被删掉的文件按标签内容重新建出来，其余照常写盘。
   * 外部改过的（冲突）与写不进去的留着不关，由调用方逐个提示。
   */
  const saveTabsBeforeClose = useMemoizedFn(
    async (paths: readonly string[]): Promise<Map<string, WorkbenchEditorSaveResult>> => {
      const tabs = paths.flatMap((path) => {
        const tab = openTabsByPathLatest.current.get(path)
        return tab ? [tab] : []
      })
      const deletedTabs = tabs.filter((tab) => tab.externalChange?.status === 'deleted')
      const results = await saveEditorTabs(
        tabs.filter((tab) => tab.externalChange?.status !== 'deleted')
      )
      if (isEmpty(deletedTabs)) return results

      beginManualSave()
      try {
        for (const tab of deletedTabs) results.set(tab.path, await restoreDeletedTab(tab))
      } finally {
        endManualSave()
      }
      if (deletedTabs.some((tab) => results.get(tab.path)?.status === 'saved')) {
        notifyFilesSaved()
        onExternalFilesChangedLatest.current()
      }
      return results
    }
  )

  /**
   * 用户对关闭确认的回答。取消：什么都不关。不保存：丢掉改动直接关。保存：先存，存好的（和本来就
   * 没改的）关掉；外部改过或写不进去的标签留着并说明原因，用户处理完再关。
   */
  function settleWindowClose(proceed: boolean): void {
    const settle = windowCloseSettleRef.current
    windowCloseSettleRef.current = null
    settle?.(proceed)
  }

  /** 关窗时选了「不保存」：放弃所有改动，页面卸载时也别再替它们写回去。 */
  function discardAllChangesForWindowClose(): void {
    const dirtyTabs = [...openTabsByPathLatest.current.values()].filter(isDirtyTab)
    skipExitFlush(dirtyTabs)
    revertOpenFiles(dirtyTabs.map((tab) => tab.path))
  }

  /**
   * 用户对关闭确认的回答。取消：什么都不关。不保存：丢掉改动直接关。保存：先存，存好的（和本来就
   * 没改的）关掉；外部改过或写不进去的标签留着并说明原因，用户处理完再关。关窗确认同理，
   * 结果交回主进程：全都存下或选了不保存才关窗。
   */
  const resolveCloseRequest = useMemoizedFn(
    async (choice: WorkbenchEditorCloseChoice): Promise<void> => {
      const request = closeRequest
      // 同一次确认只认第一个回答（连点两下「保存」、点了保存又按 Esc）。
      if (!request || isResolvingCloseRequest || answeredCloseRequestIdRef.current === request.id)
        return
      answeredCloseRequestIdRef.current = request.id

      if (choice === 'cancel') {
        setCloseRequest(null)
        if (request.kind === 'window') settleWindowClose(false)
        return
      }
      if (choice === 'discard') {
        setCloseRequest(null)
        if (request.kind === 'window') {
          discardAllChangesForWindowClose()
          settleWindowClose(true)
          return
        }
        commitCloseOpenFiles(request.paths)
        return
      }

      setIsResolvingCloseRequest(true)
      try {
        const results = await saveTabsBeforeClose(request.dirtyPaths)
        const unsavedPaths = new Set(
          request.dirtyPaths.filter((path) => {
            const status = results.get(path)?.status
            return status === 'conflict' || status === 'failed'
          })
        )
        setCloseRequest(null)
        reportUnsavedResults(summarizeWorkbenchEditorSaveResults(results))
        if (request.kind === 'window') {
          settleWindowClose(unsavedPaths.size === 0)
          return
        }
        commitCloseOpenFiles(request.paths.filter((path) => !unsavedPaths.has(path)))
      } finally {
        setIsResolvingCloseRequest(false)
      }
    }
  )

  /**
   * 主进程要关这个窗口（或退出应用）而编辑器里还有改动。先像自动保存那样把能存的都存掉：
   * 都存下了就直接关，不打扰用户；还有存不下的（外部改过、磁盘上被删、写盘失败），
   * 再问「保存全部 / 不保存 / 取消」。返回 true 表示可以关。
   */
  const confirmWindowClose = useMemoizedFn(
    (reason: WorkbenchEditorWindowCloseReason): Promise<boolean> => {
      // 已经在处理这个窗口的关闭了（又点了一次关闭、又按了一次退出）：跟着那一次的结果走。
      if (windowCloseDecisionRef.current) return windowCloseDecisionRef.current

      const decision = decideWindowClose(reason)
      windowCloseDecisionRef.current = decision
      const release = (): void => {
        if (windowCloseDecisionRef.current === decision) windowCloseDecisionRef.current = null
      }
      decision.then(release, release)
      return decision
    }
  )

  async function decideWindowClose(reason: WorkbenchEditorWindowCloseReason): Promise<boolean> {
    const dirtyTabs = [...openTabsByPathLatest.current.values()].filter(isDirtyTab)
    if (isEmpty(dirtyTabs)) return true

    const flushed = await saveEditorTabs(dirtyTabs.filter(isWorkbenchEditorTabAutosavable))
    const unsavedPaths = collectWorkbenchEditorUnsavedAfterFlush(
      dirtyTabs.map((tab) => tab.path),
      new Map([...flushed].map(([path, result]) => [path, result.status]))
    )
    if (isEmpty(unsavedPaths)) return true

    const reasons: Record<string, string> = {}
    for (const [path, result] of flushed) {
      if (result.status === 'failed') reasons[path] = result.error.message
    }
    return new Promise<boolean>((resolve) => {
      windowCloseSettleRef.current = resolve
      closeRequestSeqRef.current += 1
      // 关标签的确认还开着：让位给关窗，一起问。
      setCloseRequest({
        id: closeRequestSeqRef.current,
        kind: 'window',
        windowReason: reason,
        paths: [],
        dirtyPaths: unsavedPaths,
        reasons,
      })
    })
  }

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
    revertOpenFiles,
    selectFile,
    preloadOpenTab,
    restoreEditorSession,
    closeOpenFile,
    closeOtherOpenFiles,
    closeAllOpenFiles,
    closeUnmodifiedOpenFiles,
    closeOpenFilesToRight,
    takeRecentlyClosedTabPath,
    /** 等用户回答「保存 / 不保存 / 取消」的关闭；null 表示没有。 */
    closeRequest,
    isResolvingCloseRequest,
    resolveCloseRequest,
    confirmWindowClose,
    reorderOpenTabs,
    moveOpenEntryPath,
    closeOpenEntryPath,
    saveSelectedFile,
    saveAllOpenFiles,
    convertSelectedFileTextFormat,
    resolveSelectedExternalFileConflict,
  }
}
