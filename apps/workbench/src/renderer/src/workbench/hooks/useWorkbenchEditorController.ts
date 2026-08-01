import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  SystemWorkspaceFilesChangedEvent,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchReadFileResult,
} from '@workbench/contracts'
import { workbenchHost } from '@workbench/host'
import { applyWorkbenchLanguageServiceEditsToContent } from '@workbench/models/editor/workbenchCodeMirrorLanguageService'
import {
  buildExternalChangeNoticeKey,
  getWorkbenchEditorFilesChangedRefreshDelayMs,
  hasExternalChange,
  hasFileSnapshotChanged,
  isDirtyTab,
  movePath,
  reuseWorkbenchOpenFileSnapshots,
  WORKBENCH_EDITOR_FILES_CHANGED_DEBOUNCE_MS,
} from '@workbench/models/editor/workbenchEditorTabs'
import type { WorkbenchOpenFileSnapshot } from '@workbench/models/project/workbenchProjectContextIndex'
import type { WorkbenchProject } from '@workbench/models/project/workbenchProjects'
import { readWorkbenchLocalHistoryThrottleMs } from '@workbench/models/settings/workbenchPreferences'
import { isSameOrChildPath } from '@workbench/models/shared/workbenchUtils'
import type {
  WorkbenchOpenEditorExternalChange,
  WorkbenchOpenEditorTab,
} from '@workbench/types/workbenchTypes'

import { isEmpty, Log, optionalWhenLazy, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMemoizedFn, useMonotonicAsyncRequest, useTimerScope } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'

import { useWorkbenchEditorAutosave } from './useWorkbenchEditorAutosave'

const EXTERNAL_FILE_READ_MAX_CHARS = 300_000
const log = Log.tag('workbench-editor-controller')

interface UseWorkbenchEditorControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  onSelectEntryPath: (path: string) => void
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
  onSelectEntryPath,
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
  const [isAutomatedPreviewActive, setIsAutomatedPreviewActive] = useState(false)
  const [saveRevision, setSaveRevision] = useState(0)
  const externalChangeNoticeKeysRef = useRef(new Set<string>())
  const externalFileRefreshInFlightRef = useRef(false)
  const openedFileSnapshotsRef = useRef<WorkbenchOpenFileSnapshot[]>([])
  const pendingFilePathRef = useRef<Nullable<string>>(null)
  const timers = useTimerScope('useWorkbenchEditorController')
  const { abandonInFlightRequests, completeIfActive, isActive, start } = useMonotonicAsyncRequest()
  const selectedFilePathRef = useLatest(selectedFilePath)
  const openTabsByPathLatest = useLatest(openTabsByPath)
  const activeProjectRef = useLatest(activeProject)
  const onSelectEntryPathLatest = useLatest(onSelectEntryPath)
  const onFileMetadataSavedLatest = useLatest(onFileMetadataSaved)
  const onFileSavedLatest = useLatest(onFileSaved)
  const onExternalFilesChangedLatest = useLatest(onExternalFilesChanged)
  const silentSaveInFlightPathsRef = useRef(new Set<string>())

  const hasUnsavedChanges = !!selectedFile && editorContent !== selectedFile.content
  const hasUnsavedOpenTabs = useMemo(
    () => [...openTabsByPath.values()].some((tab) => tab.content !== tab.file.content),
    [openTabsByPath]
  )
  const canEditSelectedFile = !!selectedFile && !selectedFile.truncated
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
      const externalChange = optionalWhenLazy(
        currentTab && !hasFileSnapshotChanged(currentTab.file, file),
        () => currentTab!.externalChange
      )
      next.set(file.path, {
        path: file.path,
        file,
        content,
        externalChange,
      })
      return next
    })
  }

  const updateEditorContent = useMemoizedFn((content: string): void => {
    setEditorContent(content)
    if (selectedFile) {
      rememberOpenFile(selectedFile, content)
    }
  })

  const applyLanguageServiceFileChanges = useMemoizedFn(
    (changes: readonly WorkbenchLanguageServiceFileEdit[]): void => {
      if (isEmpty(changes)) return

      for (const change of changes) {
        const tab = openTabsByPathLatest.current.get(change.path)
        if (!tab || isEmpty(change.edits)) continue

        const nextContent = applyWorkbenchLanguageServiceEditsToContent(tab.content, change.edits)
        rememberOpenFile(tab.file, nextContent)
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
          : tLatest.current('workbench.externalFileUnavailableTitle'),
      description:
        change.status === 'modified'
          ? tLatest.current('workbench.externalFileChangedDescription', { path: tab.path })
          : (change.message ??
            tLatest.current('workbench.externalFileUnavailableDescription', { path: tab.path })),
    })
  }

  function notifyExternalFileChangedOnce(
    path: string,
    change: WorkbenchOpenEditorExternalChange
  ): void {
    const key = buildExternalChangeNoticeKey(path, change)
    if (externalChangeNoticeKeysRef.current.has(key)) return

    externalChangeNoticeKeysRef.current.add(key)
    messageLatest.current.warning({
      title:
        change.status === 'modified'
          ? tLatest.current('workbench.externalFileChangedTitle')
          : tLatest.current('workbench.externalFileUnavailableTitle'),
      description:
        change.status === 'modified'
          ? tLatest.current('workbench.externalFileChangedDescription', { path })
          : (change.message ??
            tLatest.current('workbench.externalFileUnavailableDescription', { path })),
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
    pendingFilePathRef.current = null
  })

  const revertSelectedFile = useMemoizedFn((): void => {
    if (!selectedFile) return

    setEditorContent(selectedFile.content)
    rememberOpenFile(selectedFile, selectedFile.content)
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
        onSelectEntryPathLatest.current(path)
        setSelectedFilePath(path)
        setSelectedFile(existingTab.file)
        setEditorContent(existingTab.content)
        return
      }

      const owningProjectId = activeProject.id
      const generation = start()
      pendingFilePathRef.current = path

      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.readWorkbenchFile({
            projectRoot: activeProject.rootPath,
            path,
            maxChars: 300_000,
          })
        )
        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        // JetBrains 式提交：读取完成前保留当前编辑器；就绪后同一批次提交树选中、
        // 选项卡和正文，避免半成品 tab 与“正在读取文件”占位来回闪烁。
        onSelectEntryPathLatest.current(path)
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
      const result = Result.unwrap(
        await workbenchHost.kernel.project.readWorkbenchFile({
          projectRoot: activeProject.rootPath,
          path,
          maxChars: EXTERNAL_FILE_READ_MAX_CHARS,
        })
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

    onSelectEntryPathLatest.current(nextSelectedTab.path)
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

    onSelectEntryPathLatest.current(nextSelectedTab.path)
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

    onSelectEntryPathLatest.current(nextSelectedTab.path)
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
    onSelectEntryPathLatest.current(path)
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
    const outcomes = await Promise.all(
      tabs.map(async (tab) => {
        try {
          const diskFile = Result.unwrap(
            await workbenchHost.kernel.project.readWorkbenchFile({
              projectRoot: project.rootPath,
              path: tab.path,
              maxChars: EXTERNAL_FILE_READ_MAX_CHARS,
            })
          )
          return {
            path: tab.path,
            baseContent: tab.file.content,
            baseModifiedAt: tab.file.modifiedAt,
            baseSize: tab.file.size,
            diskFile,
            error: null,
          }
        } catch (error) {
          return {
            path: tab.path,
            baseContent: tab.file.content,
            baseModifiedAt: tab.file.modifiedAt,
            baseSize: tab.file.size,
            diskFile: null,
            error: AppError.from(error),
          }
        }
      })
    )

    if (activeProjectRef.current?.id !== owningProjectId) return

    let changed = false
    let externalDetected = false
    const nextTabs = new Map(openTabsByPathLatest.current)

    for (const outcome of outcomes) {
      const tab = nextTabs.get(outcome.path)
      if (!tab) {
        continue
      }

      const baseStillCurrent =
        tab.file.modifiedAt === outcome.baseModifiedAt &&
        tab.file.size === outcome.baseSize &&
        tab.file.content === outcome.baseContent
      if (!baseStillCurrent) {
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
          notifyExternalFileChangedOnce(tab.path, externalChange)
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
        status: 'unavailable',
        detectedAt: Date.now(),
        message: outcome.error?.message,
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
        notifyExternalFileChangedOnce(tab.path, externalChange)
        changed = true
      }
      externalDetected = true
    }

    if (!changed) return

    setOpenTabsByPath(nextTabs)
    const selectedPath = selectedFilePathRef.current
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
  const runRefreshOpenFilesFromDisk = useMemoizedFn((): void => {
    if (document.visibilityState === 'hidden' || externalFileRefreshInFlightRef.current) return

    externalFileRefreshInFlightRef.current = true
    void refreshOpenFilesFromDiskLatest.current().finally(() => {
      externalFileRefreshInFlightRef.current = false
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
      const diskFile = Result.unwrap(
        await workbenchHost.kernel.project.readWorkbenchFile({
          projectRoot: project.rootPath,
          path,
          maxChars: EXTERNAL_FILE_READ_MAX_CHARS,
        })
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

  const reloadSelectedFileFromDisk = useMemoizedFn(async (): Promise<void> => {
    const path = selectedFilePathRef.current
    if (!path) return

    await reloadOpenFileFromDisk(path)
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
  }, [activeProject, refreshOpenFilesFromDisk])

  useWorkspaceFilesChangedRefresh({
    rootPath: activeProject?.rootPath,
    enabled: !!activeProject,
    refreshInFlightRef: externalFileRefreshInFlightRef,
    onChanged: (event) => {
      if (document.visibilityState === 'hidden' || !shouldRefreshOpenFilesForWorkspaceEvent(event))
        return

      if (getWorkbenchEditorFilesChangedRefreshDelayMs(event) <= 0) {
        scheduleRefreshOpenFilesFromDisk.cancel()
        runRefreshOpenFilesFromDisk()
        return
      }

      scheduleRefreshOpenFilesFromDisk()
    },
  })

  const saveEditorTab = useMemoizedFn(
    async (
      tab: WorkbenchOpenEditorTab,
      options: WorkbenchSaveEditorTabOptions = {}
    ): Promise<void> => {
      if (!activeProject || tab.file.truncated || tab.content === tab.file.content || isSavingFile)
        return
      if (options.silent && silentSaveInFlightPathsRef.current.has(tab.path)) return

      const latestTab = openTabsByPathLatest.current.get(tab.path)
      const externalChange = latestTab?.externalChange ?? tab.externalChange
      if (externalChange) {
        if (!options.silent) {
          warnExternalFileChanged({
            ...tab,
            externalChange,
          })
        }
        return
      }

      const owningProject = activeProject
      const owningProjectId = owningProject.id

      try {
        if (options.silent) {
          silentSaveInFlightPathsRef.current.add(tab.path)
        } else {
          setIsSavingFile(true)
        }
        const saved = await saveTab(owningProject, tab, options.silent)
        if (activeProjectRef.current?.id !== owningProjectId) return

        applySavedFile(saved, tab.content, options)
        if (options.notify) {
          messageLatest.current.success({
            title: tLatest.current('workbench.saveSucceeded'),
          })
        }
      } catch (error) {
        if (activeProjectRef.current?.id !== owningProjectId) return

        const appError = AppError.from(error)
        if (options.silent) {
          log.debug('工作台编辑器静默自动保存失败', {
            path: tab.path,
            error: appError.message,
          })
        } else {
          messageLatest.current.error({
            title: tLatest.current('workbench.saveFileFailed'),
            description: appError.message,
          })
        }
      } finally {
        if (options.silent) {
          silentSaveInFlightPathsRef.current.delete(tab.path)
        } else {
          setIsSavingFile(false)
        }
      }
    }
  )

  useWorkbenchEditorAutosave({
    activeProject,
    isSavingFile,
    paused: isAutomatedPreviewActive,
    openTabsByPath,
    saveEditorTab,
  })

  const saveSelectedFile = useMemoizedFn(async (): Promise<void> => {
    if (!selectedFile || !hasUnsavedChanges) return

    await saveEditorTab(
      {
        path: selectedFile.path,
        file: selectedFile,
        content: editorContent,
        externalChange: openTabsByPath.get(selectedFile.path)?.externalChange,
      },
      { notify: true }
    )
  })

  const saveAllOpenFiles = useMemoizedFn(async (): Promise<void> => {
    if (!activeProject || isSavingFile) return

    const owningProject = activeProject
    const owningProjectId = owningProject.id
    const dirtyTabs = [...openTabsByPath.values()].filter((tab) => tab.content !== tab.file.content)
    if (isEmpty(dirtyTabs)) return

    const conflictedTab = dirtyTabs.find(hasExternalChange)
    if (conflictedTab) {
      warnExternalFileChanged(conflictedTab)
      return
    }

    try {
      setIsSavingFile(true)
      const savedFiles: WorkbenchReadFileResult[] = []

      for (const tab of dirtyTabs) {
        const saved = await saveTab(owningProject, tab)
        savedFiles.push(saved)
      }

      if (activeProjectRef.current?.id !== owningProjectId) return

      setOpenTabsByPath((current) => {
        const next = new Map(current)
        for (const saved of savedFiles) {
          next.set(saved.path, {
            path: saved.path,
            file: saved,
            content: saved.content,
          })
        }
        return next
      })

      const selectedSavedFile = savedFiles.find((file) => file.path === selectedFilePath)
      if (selectedSavedFile) {
        setSelectedFile(selectedSavedFile)
        setEditorContent(selectedSavedFile.content)
      }
      savedFiles.forEach((file) => onFileMetadataSavedLatest.current(file))
      onFileSavedLatest.current()
      setSaveRevision((revision) => revision + 1)
      messageLatest.current.success({
        title: tLatest.current('workbench.saveAllSucceeded', { count: savedFiles.length }),
      })
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId) return

      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.saveFileFailed'),
        description: appError.message,
      })
    } finally {
      setIsSavingFile(false)
    }
  })

  return {
    selectedFilePath,
    selectedFile,
    editorContent,
    hasUnsavedChanges,
    hasUnsavedOpenTabs,
    canEditSelectedFile,
    openTabs,
    openedFileSnapshots,
    isSavingFile,
    saveRevision,
    setEditorContent: updateEditorContent,
    setAutomatedPreviewActive: setIsAutomatedPreviewActive,
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
    reloadSelectedFileFromDisk,
    resolveSelectedExternalFileConflict,
  }
}
