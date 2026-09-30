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
  closeWorkbenchEditorTabs,
  createWorkbenchEditorGroupsLayout,
  findWorkbenchEditorGroupIndex,
  getWorkbenchEditorFocusedPath,
  keepWorkbenchEditorPreviewTabs,
  keepWorkbenchEditorTab,
  listWorkbenchEditorLayoutPaths,
  listWorkbenchEditorTabsToCloseOthers,
  listWorkbenchEditorTabsToCloseToRight,
  listWorkbenchEditorUnpinnedTabs,
  openWorkbenchEditorTab,
  renameWorkbenchEditorLayoutPaths,
  type WorkbenchEditorGroupsLayout,
  type WorkbenchEditorOpenTabIntent,
} from '@renderer/models/editor/workbenchEditorGroups'
import { buildWorkbenchEditorGroupViews } from '@renderer/models/editor/workbenchEditorGroupViews'
import {
  appendWorkbenchEditorSavedSnapshot,
  resolveWorkbenchEditorSaveBase,
  summarizeWorkbenchEditorSaveResults,
  type WorkbenchEditorSavedSnapshot,
  type WorkbenchEditorSaveResult,
  type WorkbenchEditorSaveSummary,
} from '@renderer/models/editor/workbenchEditorSaving'
import {
  collectWorkbenchEditorUnsavedAfterFlush,
  popWorkbenchClosedEditorTab,
  pushWorkbenchClosedEditorTabs,
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
import {
  type WorkbenchLanguageServiceFileChangeFailure,
  type WorkbenchLanguageServiceFileChangeFailureReason,
  writeWorkbenchLanguageServiceFileChange,
} from '@renderer/models/editor/workbenchLanguageServiceFileChanges'
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
import { useWorkbenchEditorTabLayout } from './useWorkbenchEditorTabLayout'

const EXTERNAL_FILE_READ_MAX_CHARS = 300_000
/** 跨文件改动写回没打开的文件时最多读这么多字（与主进程的保存上限一致；更大的文件读回来是截断的，不能改）。 */
const LANGUAGE_SERVICE_EDIT_MAX_CHARS = 1_000_000
const LanguageServiceEditFailureMessageKeys: Readonly<Record<
  Exclude<WorkbenchLanguageServiceFileChangeFailureReason, 'error'>,
  string
>> = {
  'read-only': 'workbench.languageServiceEditReadOnly',
  'unsupported-text': 'workbench.languageServiceEditUnsupportedText',
  'changed-on-disk': 'workbench.languageServiceEditChangedOnDisk',
}
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
  /** 「预览标签」这项设置；关着时一律开普通标签。 */
  previewTabsEnabled?: boolean
  onFileMetadataSaved: (file: WorkbenchReadFileResult) => void
  onFileSaved: () => void
  onExternalFilesChanged: () => void
}

export interface WorkbenchFileOpenOptions extends WorkbenchEditorOpenTabIntent {
  quiet?: boolean
  /** 文件还没开着时标签开在哪一组（后退 / 前进回到原来那一组）；不给就是当前组。已经开着的文件在哪组就去哪组。 */
  groupIndex?: number
}

interface WorkbenchSaveEditorTabOptions {
  notify?: boolean
  silent?: boolean
}

export function useWorkbenchEditorController({
  activeProject,
  previewTabsEnabled = true,
  onFileMetadataSaved,
  onFileSaved,
  onExternalFilesChanged,
}: UseWorkbenchEditorControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  // 开着的文件的正文与磁盘快照，按路径存；标签栏上怎么排、每组显示哪个、当前组是哪个在标签布局里。
  // 两边的路径始终是同一批：加、关、改名都在同一轮里一起改。
  const [openTabsByPath, setOpenTabsByPath] = useState<Map<string, WorkbenchOpenEditorTab>>(
    () => new Map()
  )
  const {
    layout,
    layoutRef,
    commitLayout,
    reorderOpenTabs,
    keepOpenFile,
    pinOpenFile,
    unpinOpenFile,
    focusEditorGroup,
    moveOpenFileToGroup,
    setEditorSplitRatio,
  } = useWorkbenchEditorTabLayout()
  const previewTabsEnabledLatest = useLatest(previewTabsEnabled)
  // 「当前文件」就是当前组正在显示的那个标签：它的磁盘快照与正文取自标签本身，不另存一份。
  const selectedFilePath = getWorkbenchEditorFocusedPath(layout)
  const selectedTab = selectedFilePath ? openTabsByPath.get(selectedFilePath) : undefined
  const selectedFile = toNullable(selectedTab?.file)
  const editorContent = selectedTab?.content ?? ''
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
  // 还在读的那个文件又被普通打开了一次（双击的第二下）：读完开成普通标签，不是预览。
  const pendingOpenKeepsTabRef = useRef(false)
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

  const hasUnsavedChanges = !!selectedTab && isDirtyTab(selectedTab)
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
  // 标签栏顺序的标签（按组从左到右）。
  const openTabs = useMemo(
    () =>
      listWorkbenchEditorLayoutPaths(layout).flatMap((path) => {
        const tab = openTabsByPath.get(path)
        return tab ? [tab] : []
      }),
    [layout, openTabsByPath]
  )
  // 每一组的样子（标签、正在显示的文件、能不能编辑），给各组的面板渲染。
  const editorGroups = useMemo(
    () => buildWorkbenchEditorGroupViews(layout, openTabsByPath, chosenEditModes),
    [chosenEditModes, layout, openTabsByPath]
  )
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
   * 正文一改，预览标签就留下：有改动的标签不会被下一次预览顶替掉。
   */
  function updateOpenTabContent(file: WorkbenchReadFileResult, content: string): void {
    keepOpenFile(file.path)
    setOpenTabsByPath((current) => {
      const currentTab = current.get(file.path)
      // 标签已经关掉了（改动到得比关闭晚）：不把它凭空加回来，标签布局里已经没有它了。
      if (!currentTab || currentTab.content === content) return current

      const nextTab = { ...currentTab, content, unencodableSaveError: undefined }
      return new Map(current).set(file.path, nextTab)
    })
  }

  /** 编辑器里的输入：改的是那个编辑器正在显示的文件（`path`，另一组的编辑器也经这里）；不给就是当前文件。 */
  const updateEditorContent = useMemoizedFn((content: string, path?: string): void => {
    const file = path ? openTabsByPath.get(path)?.file : selectedFile
    if (!file || !isWorkbenchFileEditable(file, chosenEditModes.get(file.path))) return

    updateOpenTabContent(file, content)
  })

  /** 把一组语言服务的改动套到文件上（格式化这类），不报告结果；见 applyLanguageServiceEditsToFiles。 */
  const applyLanguageServiceFileChanges = useMemoizedFn(
    (changes: readonly WorkbenchLanguageServiceFileEdit[]): void => {
      void applyLanguageServiceEditsToFiles(changes)
    }
  )

  /**
   * 跨文件改名：套上改动，报告一共改了几个文件；有落不下去的，逐个说明是哪个文件、为什么。
   * `editedInEditor` 是编辑器自己已经改好的文件数（发起重命名的当前文件）。
   */
  const applyLanguageServiceRename = useMemoizedFn(
    (
      changes: readonly WorkbenchLanguageServiceFileEdit[],
      { editedInEditor = 0 }: { editedInEditor?: number } = {}
    ): void => {
      void applyLanguageServiceEditsToFiles(changes).then(({ changedFiles, failures }) => {
        const t = tLatest.current
        const count = changedFiles + editedInEditor
        if (isEmpty(failures)) {
          messageLatest.current.success({ title: t('workbench.languageServiceEditsApplied', { count }) })
          return
        }
        messageLatest.current.warning({
          title: t('workbench.languageServiceEditsPartial', { count }),
          description: failures
            .map((failure) => t('workbench.languageServiceEditFailedFile', {
              path: failure.path,
              reason: failure.reason === 'error'
                ? (failure.message ?? '')
                : t(LanguageServiceEditFailureMessageKeys[failure.reason]),
            }))
            .join(t('workbench.languageServiceEditFailureSeparator')),
        })
      })
    }
  )

  /**
   * 语言服务的跨文件改动：打开着的文件改编辑缓冲（留作未保存、可以看过再存），没打开的文件经主进程的保存管线直接
   * 写回（编码与换行符照旧）。只读的标签不接这些改动。返回改了几个文件、哪些没改成。
   */
  async function applyLanguageServiceEditsToFiles(
    changes: readonly WorkbenchLanguageServiceFileEdit[]
  ): Promise<{ changedFiles: number; failures: WorkbenchLanguageServiceFileChangeFailure[] }> {
    const projectRoot = activeProjectRef.current?.rootPath
    const failures: WorkbenchLanguageServiceFileChangeFailure[] = []
    let changedFiles = 0
    if (!projectRoot) return { changedFiles, failures }

    for (const change of changes) {
      if (isEmpty(change.edits)) continue
      const tab = openTabsByPathLatest.current.get(change.path)
      if (tab) {
        if (!isWorkbenchFileEditable(tab.file, chosenEditModes.get(tab.path))) {
          failures.push({ path: change.path, reason: 'read-only' })
          continue
        }
        const nextContent = applyWorkbenchLanguageServiceEditsToContent(tab.content, change.edits)
        updateOpenTabContent(tab.file, nextContent)
        changedFiles += 1
        continue
      }

      const failure = await writeWorkbenchLanguageServiceFileChange(change, {
        readFile: (path) => readWorkbenchEditorFile(projectRoot, path, LANGUAGE_SERVICE_EDIT_MAX_CHARS),
        saveFile: (request) => workbenchHost.kernel.project.saveWorkbenchFile({ projectRoot, ...request }),
      })
      if (failure) failures.push(failure)
      else changedFiles += 1
    }
    return { changedFiles, failures }
  }

  /**
   * 项目搜索的替换落到开着的文件上：在标签的正文上换，不写盘。当前文件由编辑器按一次外部改动套进来，别的标签
   * 切回来时同样套进来，都能 ⌘Z 撤回；没保存的改动还在，替换是在它们上面做的。只读的标签不换。
   * 返回换了的与只读没换的路径；没开着的路径两边都不在，调用方交给磁盘替换。
   */
  const replaceOpenTabContents = useMemoizedFn(
    (
      changes: ReadonlyArray<{ path: string; replace: (content: string) => string }>
    ): { replacedPaths: string[]; readOnlyPaths: string[] } => {
      const replacedPaths: string[] = []
      const readOnlyPaths: string[] = []
      for (const change of changes) {
        const tab = openTabsByPathLatest.current.get(change.path)
        if (!tab) continue
        if (!isWorkbenchFileEditable(tab.file, chosenEditModes.get(tab.path))) {
          readOnlyPaths.push(change.path)
          continue
        }

        const nextContent = change.replace(tab.content)
        if (nextContent === tab.content) continue
        updateOpenTabContent(tab.file, nextContent)
        replacedPaths.push(change.path)
      }
      return { replacedPaths, readOnlyPaths }
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
    commitLayout(createWorkbenchEditorGroupsLayout())
    setOpenTabsByPath(new Map())
    setChosenEditModes(new Map())
    pendingFilePathRef.current = null
    closedTabPathsRef.current = []
  })

  /**
   * 在只读与编辑之间切换一个文件（不给路径就是当前文件）；没有完整文本的文件（图片、截断的大文件）不能
   * 切到编辑。
   */
  const toggleSelectedFileEditMode = useMemoizedFn((path?: string): void => {
    const file = path ? openTabsByPath.get(path)?.file : selectedFile
    if (!file || !canEditWorkbenchFileContent(file)) return

    const mode = resolveWorkbenchEditorEditMode(file, chosenEditModes.get(file.path))
    const nextMode: WorkbenchEditorEditMode = mode === 'edit' ? 'read-only' : 'edit'
    setChosenEditModes((current) => new Map(current).set(file.path, nextMode))
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
    const adoptedDiskFiles = revertedTabs.filter((tab) => tab.file !== openTabsByPath.get(tab.path)?.file)
    if (!isEmpty(adoptedDiskFiles)) {
      adoptedDiskFiles.forEach((tab) => onFileMetadataSavedLatest.current(tab.file))
      onExternalFilesChangedLatest.current()
    }
  })

  /**
   * 在布局里打开（或切到）一个正文已经在手的文件。以预览方式打开时顶替掉的那个预览标签，它的文件一起关掉：
   * 预览标签没有未保存的改动（一改就留下了），不用问。
   */
  function showOpenTab(path: string, options: WorkbenchFileOpenOptions): void {
    let current = layoutRef.current
    const sourcePath = getWorkbenchEditorFocusedPath(current)
    if (options.keepSource && sourcePath && sourcePath !== path)
      current = keepWorkbenchEditorTab(current, sourcePath)
    // 兜底：预览标签万一带着没保存的改动，先留下，不让它被顶替掉。
    for (const { previewPath } of current.groups) {
      const previewTab = previewPath ? openTabsByPathLatest.current.get(previewPath) : undefined
      if (previewPath && previewTab && isDirtyTab(previewTab))
        current = keepWorkbenchEditorTab(current, previewPath)
    }

    const opened = openWorkbenchEditorTab(current, path, {
      preview: !!options.preview && previewTabsEnabledLatest.current,
      groupIndex: options.groupIndex,
    })
    commitLayout(opened.layout)
    if (opened.replacedPath) forgetOpenTabs([opened.replacedPath])
  }

  /**
   * 打开一个文件并切过去。返回标签的路径（主进程按规范化后的路径回报，可能与传进来的写法不同）；没打开
   * （读不出来、被后来的打开顶掉、同一个文件还在读）返回 null。
   */
  const selectFile = useMemoizedFn(
    async (path: string, options: WorkbenchFileOpenOptions = {}): Promise<Nullable<string>> => {
      if (!activeProject) return null

      // 已经开着（包括就是当前文件）：放下还在读的那个文件，切过去。
      if (findWorkbenchEditorGroupIndex(layoutRef.current, path) >= 0) {
        if (pendingFilePathRef.current) {
          abandonInFlightRequests()
          pendingFilePathRef.current = null
        }
        showOpenTab(path, options)
        return path
      }
      if (path === pendingFilePathRef.current) {
        if (!options.preview) pendingOpenKeepsTabRef.current = true
        return null
      }

      const owningProjectId = activeProject.id
      const generation = start()
      pendingFilePathRef.current = path
      pendingOpenKeepsTabRef.current = false

      try {
        const result = await readWorkbenchEditorFile(activeProject.rootPath, path, 300_000)
        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return null

        // JetBrains 式提交：读取完成前保留当前编辑器；就绪后同一批次提交
        // 选项卡和正文，避免半成品 tab 与“正在读取文件”占位来回闪烁。
        // 主进程按规范化后的路径回报，以它为准：同一个文件不会因为写法不同开出两个标签、盖掉没保存的正文。
        if (findWorkbenchEditorGroupIndex(layoutRef.current, result.path) < 0)
          rememberOpenFile(result, result.content)
        showOpenTab(
          result.path,
          pendingOpenKeepsTabRef.current ? { ...options, preview: false } : options
        )
        return result.path
      } catch (error) {
        const appError = AppError.from(error)
        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return null

        if (!options.quiet) {
          messageLatest.current.error({
            title: tLatest.current('workbench.readFileFailed'),
            description: appError.message,
          })
        }
        return null
      } finally {
        completeIfActive(generation, () => {
          if (pendingFilePathRef.current === path) pendingFilePathRef.current = null
        })
      }
    }
  )

  /**
   * 恢复上次会话的标签布局：把里面的文件都读出来，读好了一次提交（读不出来的标签丢掉，那一组改显示
   * 相邻的标签）。恢复期间用户自己点开的文件留着，并且停在它上面。
   */
  const restoreEditorSession = useMemoizedFn(
    async (savedLayout: WorkbenchEditorGroupsLayout): Promise<void> => {
      if (!activeProject) return

      const savedPaths = listWorkbenchEditorLayoutPaths(savedLayout)
      if (isEmpty(savedPaths)) return

      const owningProjectId = activeProject.id
      const restoredFiles = new Map<string, WorkbenchReadFileResult>()
      for (const path of savedPaths) {
        try {
          const file = await readWorkbenchEditorFile(
            activeProject.rootPath,
            path,
            EXTERNAL_FILE_READ_MAX_CHARS
          )
          if (file.path === path) restoredFiles.set(path, file)
        } catch (error) {
          log.debug('恢复 workbench 打开文件失败', { path, error })
        }
        if (activeProjectRef.current?.id !== owningProjectId) return
      }

      setOpenTabsByPath((current) => {
        const next = new Map(current)
        for (const [path, file] of restoredFiles) {
          if (!next.has(path)) next.set(path, { path, file, content: file.content })
        }
        return next
      })
      const openedMeanwhile = listWorkbenchEditorLayoutPaths(layoutRef.current)
      commitLayout(
        openedMeanwhile.reduce(
          // 存下的布局里本来就有它：只是切过去，是不是预览照存下的；没有：加一个普通标签。
          (restored, path) =>
            openWorkbenchEditorTab(restored, path, {
              preview: findWorkbenchEditorGroupIndex(restored, path) >= 0,
            }).layout,
          closeWorkbenchEditorTabs(
            savedLayout,
            savedPaths.filter((path) => !restoredFiles.has(path) && !openedMeanwhile.includes(path))
          )
        )
      )
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
      commitLayout(
        renameWorkbenchEditorLayoutPaths(layoutRef.current, (path) =>
          isSameOrChildPath(path, previousPath) ? movePath(path, previousPath, nextPath) : path
        )
      )
    }
  )

  /** 这些标签已经不在布局里了：把它们的正文与写盘记录丢掉。 */
  function forgetOpenTabs(paths: readonly string[]): void {
    setOpenTabsByPath((current) => {
      const next = new Map(current)
      paths.forEach((path) => next.delete(path))
      return next
    })
    paths.forEach((path) => savedSnapshotTrailsRef.current.delete(path))
  }

  /** 把这些标签从正文表与标签布局里一起拿掉；布局给每一组选好接下来显示哪个。 */
  function dropOpenTabs(paths: readonly string[]): void {
    commitLayout(closeWorkbenchEditorTabs(layoutRef.current, paths))
    forgetOpenTabs(paths)
  }

  // 关掉「预览标签」这项设置：已有的预览标签就此留下。
  useEffect(() => {
    if (!previewTabsEnabled) commitLayout(keepWorkbenchEditorPreviewTabs(layoutRef.current))
  }, [commitLayout, layoutRef, previewTabsEnabled])

  /** 文件（或它所在的目录）在文件树里被删掉、挪走了：它的标签跟着关掉，不问、也不记进「重新打开」。 */
  const closeOpenEntryPath = useMemoizedFn((path: string): void => {
    const removedPaths = listWorkbenchEditorLayoutPaths(layoutRef.current).filter((tabPath) =>
      isSameOrChildPath(tabPath, path)
    )
    if (!isEmpty(removedPaths)) dropOpenTabs(removedPaths)
  })

  /** 真正关掉这些标签（不再过问未保存改动），关的是当前标签时按关闭前的顺序选好下一个。 */
  const commitCloseOpenFiles = useMemoizedFn((paths: readonly string[]): void => {
    const closing = new Set(paths)
    // 按关闭前的标签栏顺序：「重新打开关闭的标签」照这个顺序往回取。
    const closingPaths = listWorkbenchEditorLayoutPaths(layoutRef.current).filter((path) =>
      closing.has(path)
    )
    if (isEmpty(closingPaths)) return

    dropOpenTabs(closingPaths)
    closedTabPathsRef.current = pushWorkbenchClosedEditorTabs(closedTabPathsRef.current, closingPaths)
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

  // 「关闭全部 / 未修改 / 其他 / 右侧」都跳过固定标签：固定标签只能逐个关（先取消固定，或文件被删掉）。
  // 标签栏上的「关闭全部 / 未修改」只管自己那一组（`groupIndex`）；不给组就是所有组。
  const closeAllOpenFiles = useMemoizedFn((groupIndex?: number): void => {
    requestCloseOpenFiles(listWorkbenchEditorUnpinnedTabs(layoutRef.current, groupIndex))
  })

  const closeUnmodifiedOpenFiles = useMemoizedFn((groupIndex?: number): void => {
    commitCloseOpenFiles(
      listWorkbenchEditorUnpinnedTabs(layoutRef.current, groupIndex).filter((path) => {
        const tab = openTabsByPath.get(path)
        return !!tab && !isDirtyTab(tab)
      })
    )
  })

  const closeOtherOpenFiles = useMemoizedFn((path: string): void => {
    requestCloseOpenFiles(listWorkbenchEditorTabsToCloseOthers(layoutRef.current, path))
  })

  const closeOpenFilesToRight = useMemoizedFn((path: string): void => {
    requestCloseOpenFiles(listWorkbenchEditorTabsToCloseToRight(layoutRef.current, path))
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
        // 在函数式更新里比对最新的正文：保存期间又打了字就留着，不把保存那一刻的旧内容回灌进正在输入的
        // 文档（否则整篇重新同步、光标跳动、补全面板消失）。
        content: currentTab.content === savedContent ? saved.content : currentTab.content,
      })
      return next
    })

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

    onFileMetadataSavedLatest.current(diskFile)
    onExternalFilesChangedLatest.current()
  })

  /** 处理一个文件的外部改动冲突（不给路径就是当前文件）。 */
  const resolveSelectedExternalFileConflict = useMemoizedFn(
    async (resolution: 'external' | 'local', targetPath?: string): Promise<void> => {
      const path = targetPath ?? selectedFilePathRef.current
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
   * 保存一个文件：不给路径就是当前文件；在某一组的编辑器里按 ⌘S 时是那个编辑器正在显示的文件。`content` 是
   * 编辑器这一刻的正文：在编辑区里按 ⌘S 时刚格式化、收拾过空白，标签里的正文要等下一次渲染才跟上；不给就用
   * 标签里的。
   */
  const saveSelectedFile = useMemoizedFn(async (content?: string, path?: string): Promise<void> => {
    const targetPath = path ?? selectedFilePath
    const tab = targetPath ? openTabsByPath.get(targetPath) : undefined
    if (!tab) return
    // 明确按了保存：预览标签就此留下，哪怕没有要存的改动（与 VS Code 一致）。
    keepOpenFile(tab.path)
    const nextContent = content ?? tab.content
    if (!isDirtyTab({ file: tab.file, content: nextContent, textConversion: tab.textConversion }))
      return

    await saveEditorTab(
      {
        path: tab.path,
        file: tab.file,
        content: nextContent,
        textConversion: tab.textConversion,
        externalChange: tab.externalChange,
      },
      { notify: true }
    )
  })

  /**
   * 用户明确选的格式转换（转换为 UTF-8、换换行符）：记到标签上（算未保存）并立即保存；不给路径就是
   * 当前文件。与磁盘上的格式一样又能原样写回时只是撤掉之前没存下去的转换。
   */
  const convertSelectedFileTextFormat = useMemoizedFn(
    async (format: WorkbenchTextFormat, targetPath?: string): Promise<void> => {
      const path = targetPath ?? selectedFilePathRef.current
      const tab = path ? openTabsByPathLatest.current.get(path) : undefined
      if (!tab || tab.file.imagePreview || tab.file.truncated) return

      const textConversion = resolveWorkbenchTextConversion(tab.file, format)
      keepOpenFile(tab.path)
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
    /** 标签布局：左右两组的标签栏顺序与当前标签、当前组、分隔条位置；随项目会话存盘。 */
    editorLayout: layout,
    /** 每一组的样子：标签、正在显示的文件、能不能编辑。 */
    editorGroups,
    openedFileSnapshots,
    isSavingFile,
    /** 自动保存存不下的文件与原因（按路径）；存好、撤回或关掉标签后撤销。 */
    autosaveFailures,
    saveRevision,
    externalRevision,
    setEditorContent: updateEditorContent,
    applyLanguageServiceFileChanges,
    applyLanguageServiceRename,
    replaceOpenTabContents,
    ensureNoUnsavedChanges,
    ensureNoUnsavedFilesInPath,
    resetSelectedFile,
    revertOpenFiles,
    selectFile,
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
    /** 把预览标签留下，变成普通标签；不是预览标签时什么也不做。 */
    keepOpenFile,
    /** 固定 / 取消固定标签：固定标签排在标签栏左边，批量关闭与 ⌘W 都不关它。 */
    pinOpenFile,
    unpinOpenFile,
    /** 把全局动作交给另一组；把标签挪到另一组（右边那组不存在就新开）；拖分隔条。 */
    focusEditorGroup,
    moveOpenFileToGroup,
    setEditorSplitRatio,
    moveOpenEntryPath,
    closeOpenEntryPath,
    saveSelectedFile,
    saveAllOpenFiles,
    convertSelectedFileTextFormat,
    resolveSelectedExternalFileConflict,
  }
}
