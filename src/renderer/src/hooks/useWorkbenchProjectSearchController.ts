/**
 * 项目搜索面板（侧栏的搜索，⇧⌘F）：查找词之外的开关、包含 / 排除的文件、替换，以及结果。
 *
 * - 查找词与按文件名找共用一个输入框（useWorkbenchSearchController 管着）；这里在它上面搜内容。
 * - 输入停一小会儿再搜；新的搜索开始时取消还没搜完的旧搜索；结果边搜边显示。
 * - 编辑器里开着的文件以编辑器里的正文为准（见 workbenchProjectSearchModel），正文一改结果跟着变；开着的文件
 *   关掉了，就按磁盘重新搜它。
 * - 替换一处、一个文件或全部（全部先确认）：开着的文件在编辑器里换，能撤销、不写盘；其余的交给 main 写盘，
 *   写完刷新那几个文件的结果（全部替换后整个重搜）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import {
  formatWorkbenchProjectSearchCount,
  mergeWorkbenchProjectSearchFiles,
  searchWorkbenchEditorText,
  summarizeWorkbenchProjectSearch,
  type WorkbenchProjectSearchFile,
} from '@renderer/models/files/workbenchProjectSearchModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type {
  WorkbenchContentSearchFileResult,
  WorkbenchContentSearchMatchResult,
  WorkbenchSearchContentBatch,
} from '@shared/contracts'
import { compileWorkbenchSearchPathFilter } from '@shared/workbenchSearchGlob'
import {
  compileWorkbenchTextSearch,
  DefaultWorkbenchTextSearchOptions,
  escapeWorkbenchTextSearchRegExp,
  replaceWorkbenchTextSearchMatches,
  WorkbenchContentSearchDefaultLimit,
  type WorkbenchTextSearchMatcher,
  type WorkbenchTextSearchOptions,
  workbenchTextSearchRangeKey,
} from '@shared/workbenchTextSearch'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMemoizedFn } from '../support/genericHooks'

/** 输入停这么久再搜。 */
const SearchDebounceMs = 200
/** 一次最多列出的匹配数（main 与开着的文件各自按它截）。 */
export const WorkbenchProjectSearchLimit = WorkbenchContentSearchDefaultLimit

export interface WorkbenchProjectSearchReplaceTarget {
  file: WorkbenchProjectSearchFile
  /** 只换这几处；不给就换这个文件里的全部。 */
  matches?: readonly WorkbenchContentSearchMatchResult[]
}

interface UseWorkbenchProjectSearchControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  openTabs: readonly WorkbenchOpenEditorTab[]
  /** 输入框里的查找词（原样，不去空白）。 */
  query: string
  onQueryChange: (query: string) => void
  /** 收起搜索：清掉查找词，文件树回来。 */
  onResetQuery: () => void
  /** 在开着的标签上替换（见 useWorkbenchEditorController.replaceOpenTabContents）。 */
  replaceOpenTabContents: (
    changes: ReadonlyArray<{ path: string; replace: (content: string) => string }>
  ) => { replacedPaths: string[]; readOnlyPaths: string[] }
  /** 打开一处匹配：跳到那个文件，选中匹配。 */
  onOpenMatch: (path: string, match: WorkbenchContentSearchMatchResult) => void
}

interface ProjectSearchResultsState {
  /** 这份结果属于哪一次搜索；搜索之间的推送、刷新按它认。 */
  generation: number
  /** 还在推送结果的那次搜索。 */
  searchId: Nullable<string>
  diskFiles: ReadonlyMap<string, WorkbenchContentSearchFileResult>
  /** 确认落在搜索范围里的路径：搜到的文件，加上报回来的开着的文件（它们以编辑器正文为准）。 */
  scopePaths: ReadonlySet<string>
  status: 'idle' | 'searching' | 'done'
  truncated: boolean
  skippedLargeFileCount: number
}

interface EditorResultCacheEntry {
  content: string
  matcher: WorkbenchTextSearchMatcher
  result: WorkbenchContentSearchFileResult
}

const EmptyResults: ProjectSearchResultsState = {
  generation: 0,
  searchId: null,
  diskFiles: new Map(),
  scopePaths: new Set(),
  status: 'idle',
  truncated: false,
  skippedLargeFileCount: 0,
}

/** 开着的文件里能在编辑器正文上搜的：完整的文本（截断的大文件与图片交给磁盘搜索）。 */
function isSearchableOpenTab(tab: WorkbenchOpenEditorTab): boolean {
  return !tab.file.imagePreview && !tab.file.truncated
}

function createSearchId(): string {
  return globalThis.crypto.randomUUID()
}

export function useWorkbenchProjectSearchController(options: UseWorkbenchProjectSearchControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [isOpen, setIsOpen] = useState(false)
  const [focusPending, setFocusPending] = useState(false)
  const [searchOptions, setSearchOptions] = useState<WorkbenchTextSearchOptions>(
    DefaultWorkbenchTextSearchOptions
  )
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [results, setResults] = useState<ProjectSearchResultsState>(EmptyResults)
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [entriesCollapsed, setEntriesCollapsed] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const activeProjectRef = useLatest(options.activeProject)
  const openTabsRef = useLatest(options.openTabs)
  const resultsRef = useLatest(results)
  const generationRef = useRef(0)
  const isReplacingRef = useRef(false)
  const editorResultCacheRef = useRef(new Map<string, EditorResultCacheEntry>())

  const compiled = useMemo(
    () => compileWorkbenchTextSearch({ query: options.query, ...searchOptions }),
    [options.query, searchOptions]
  )
  const matcher = compiled.status === 'ready' && options.query.trim() ? compiled.matcher : null
  const regexError = compiled.status === 'invalid' ? compiled.message : null
  const pathFilter = useMemo(() => compileWorkbenchSearchPathFilter(include, exclude), [exclude, include])
  const projectRoot = options.activeProject?.rootPath ?? null
  /** 这些一变就重搜。 */
  const searchKey = matcher && projectRoot
    ? JSON.stringify([projectRoot, options.query, searchOptions, include, exclude])
    : null

  /** 按当前的查找词、开关与范围发一次搜索请求。 */
  const buildRequest = () => ({
    projectRoot: activeProjectRef.current?.rootPath ?? '',
    query: options.query,
    ...searchOptions,
    include,
    exclude,
    limit: WorkbenchProjectSearchLimit,
  })

  const cancelRunningSearch = useMemoizedFn((): void => {
    const searchId = resultsRef.current.searchId
    if (searchId) void workbenchHost.kernel.project.cancelWorkbenchContentSearch({ searchId })
  })

  /** 收一批结果：搜到的文件与确认在范围里的开着的文件。已经关掉的开着的文件按磁盘重搜。 */
  const applyBatch = useMemoizedFn((generation: number, batch: WorkbenchSearchContentBatch): void => {
    if (resultsRef.current.generation !== generation) return
    setResults((current) => {
      if (current.generation !== generation) return current
      const diskFiles = new Map(current.diskFiles)
      for (const file of batch.files) diskFiles.set(file.path, file)
      const scopePaths = new Set(current.scopePaths)
      for (const path of batch.openPathsInScope) scopePaths.add(path)
      for (const file of batch.files) scopePaths.add(file.path)
      return { ...current, diskFiles, scopePaths }
    })

    const openPaths = new Set(openTabsRef.current.filter(isSearchableOpenTab).map((tab) => tab.path))
    const closed = batch.openPathsInScope.filter((path) => !openPaths.has(path))
    if (closed.length > 0) void refreshPaths(closed)
  })

  const runSearch = useMemoizedFn(async (): Promise<void> => {
    cancelRunningSearch()
    generationRef.current += 1
    const generation = generationRef.current
    if (!matcher || !activeProjectRef.current) {
      setResults({ ...EmptyResults, generation })
      return
    }

    const searchId = createSearchId()
    setResults({ ...EmptyResults, generation, searchId, status: 'searching' })
    setCollapsedPaths(new Set())
    resultsRef.current = { ...EmptyResults, generation, searchId, status: 'searching' }
    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.searchWorkbenchContent({
          ...buildRequest(),
          openPaths: openTabsRef.current.filter(isSearchableOpenTab).map((tab) => tab.path),
          searchId,
        })
      )
      applyBatch(generation, result)
      setResults((current) =>
        current.generation !== generation
          ? current
          : {
              ...current,
              searchId: null,
              status: 'done',
              truncated: result.truncated,
              skippedLargeFileCount: result.skippedLargeFileCount,
            }
      )
    } catch (error) {
      if (generationRef.current !== generation) return
      setResults((current) =>
        current.generation !== generation ? current : { ...current, searchId: null, status: 'done' }
      )
      messageLatest.current.error({
        title: tLatest.current('workbench.searchFailed'),
        description: AppError.from(error).message,
      })
    }
  })

  /** 按磁盘重搜几个文件（替换之后、开着的文件关掉之后），结果并回当前这次搜索。 */
  const refreshPaths = useMemoizedFn(async (paths: readonly string[]): Promise<void> => {
    const generation = resultsRef.current.generation
    if (!matcher || !activeProjectRef.current || paths.length === 0) return

    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.searchWorkbenchContent({ ...buildRequest(), paths: [...paths] })
      )
      setResults((current) => {
        if (current.generation !== generation) return current
        const diskFiles = new Map(current.diskFiles)
        for (const path of paths) diskFiles.delete(path)
        for (const file of result.files) diskFiles.set(file.path, file)
        return { ...current, diskFiles, scopePaths: new Set([...current.scopePaths, ...paths]) }
      })
    } catch (error) {
      if (resultsRef.current.generation !== generation) return
      messageLatest.current.error({
        title: tLatest.current('workbench.searchFailed'),
        description: AppError.from(error).message,
      })
    }
  })

  useEffect(
    () =>
      workbenchHost.kernel.project.onWorkbenchContentSearchProgress((event) => {
        const current = resultsRef.current
        if (event.searchId === current.searchId) applyBatch(current.generation, event)
      }),
    [applyBatch, resultsRef]
  )

  useEffect(() => {
    if (!searchKey) {
      cancelRunningSearch()
      generationRef.current += 1
      setResults({ ...EmptyResults, generation: generationRef.current })
      return undefined
    }

    const timer = setTimeout(() => void runSearch(), SearchDebounceMs)
    return () => clearTimeout(timer)
  }, [cancelRunningSearch, runSearch, searchKey])

  useEffect(() => () => cancelRunningSearch(), [cancelRunningSearch])

  // 开着的文件关掉了：它的结果原先按编辑器正文算，现在按磁盘重搜。
  const previousOpenPathsRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const openPaths = new Set(options.openTabs.filter(isSearchableOpenTab).map((tab) => tab.path))
    const closed = [...previousOpenPathsRef.current].filter(
      (path) => !openPaths.has(path) && resultsRef.current.scopePaths.has(path)
    )
    previousOpenPathsRef.current = openPaths
    if (closed.length > 0) void refreshPaths(closed)
  }, [options.openTabs, refreshPaths, resultsRef])

  // 开着的、在范围里的文件按编辑器里的正文搜；正文没变的沿用上次的结果。
  const editorFiles = useMemo(() => {
    const files = new Map<string, WorkbenchContentSearchFileResult>()
    const cache = editorResultCacheRef.current
    if (!matcher) {
      cache.clear()
      return files
    }

    for (const tab of options.openTabs) {
      if (!isSearchableOpenTab(tab) || !results.scopePaths.has(tab.path)) continue
      const cached = cache.get(tab.path)
      const result =
        cached && cached.content === tab.content && cached.matcher === matcher
          ? cached.result
          : searchWorkbenchEditorText({
              path: tab.path,
              content: tab.content,
              modifiedAt: tab.file.modifiedAt,
              size: tab.file.size,
              matcher,
              limit: WorkbenchProjectSearchLimit,
            })
      cache.set(tab.path, { content: tab.content, matcher, result })
      files.set(tab.path, result)
    }
    for (const path of [...cache.keys()]) if (!files.has(path)) cache.delete(path)
    return files
  }, [matcher, options.openTabs, results.scopePaths])

  const files = useMemo(
    () => mergeWorkbenchProjectSearchFiles(results.diskFiles, editorFiles),
    [editorFiles, results.diskFiles]
  )
  const summary = useMemo(() => summarizeWorkbenchProjectSearch(files), [files])

  const replaceTargets = useMemoizedFn(
    async (
      targets: readonly WorkbenchProjectSearchReplaceTarget[],
      refresh: 'files' | 'all'
    ): Promise<void> => {
      const project = activeProjectRef.current
      if (!project || !matcher || targets.length === 0 || isReplacingRef.current) return

      isReplacingRef.current = true
      setIsReplacing(true)
      const text = replacement
      const replacedCounts = new Map<string, number>()
      const failures: string[] = []
      try {
        const editorTargets = targets.filter((target) => target.file.source === 'editor')
        const { replacedPaths, readOnlyPaths } = options.replaceOpenTabContents(
          editorTargets.map((target) => ({
            path: target.file.path,
            replace: (content) => {
              const selected = target.matches
                ? new Set(target.matches.map(workbenchTextSearchRangeKey))
                : null
              const replaced = replaceWorkbenchTextSearchMatches(
                content,
                matcher,
                text,
                selected ? (hit) => selected.has(workbenchTextSearchRangeKey(hit)) : undefined
              )
              replacedCounts.set(target.file.path, replaced.count)
              return replaced.content
            },
          }))
        )
        // 刚好被关掉的：结果按的是已经不在的正文，按磁盘重搜它。
        const readOnly = new Set(readOnlyPaths)
        const vanishedPaths = editorTargets
          .map((target) => target.file.path)
          .filter((path) => !replacedCounts.has(path) && !readOnly.has(path))

        const diskTargets = targets.filter((target) => target.file.source === 'disk')
        if (diskTargets.length > 0) {
          const result = Result.unwrap(
            await workbenchHost.kernel.project.replaceWorkbenchContent({
              projectRoot: project.rootPath,
              query: options.query,
              ...searchOptions,
              replacement: text,
              files: diskTargets.map((target) => ({
                path: target.file.path,
                expectedModifiedAt: target.file.modifiedAt,
                expectedSize: target.file.size,
                matches: target.matches?.map(({ line, column, endLine, endColumn }) => ({
                  line,
                  column,
                  endLine,
                  endColumn,
                })),
              })),
            })
          )
          for (const file of result.files) {
            if (file.error) failures.push(`${file.path}: ${file.error.message}`)
            else replacedCounts.set(file.path, file.replacedCount)
          }
        }

        reportReplacement(replacedCounts, replacedPaths.length, readOnlyPaths.length, failures)
        if (refresh === 'all') void runSearch()
        else void refreshPaths([...diskTargets.map((target) => target.file.path), ...vanishedPaths])
      } catch (error) {
        messageLatest.current.error({
          title: tLatest.current('workbench.projectSearchReplaceFailed'),
          description: AppError.from(error).message,
        })
      } finally {
        isReplacingRef.current = false
        setIsReplacing(false)
      }
    }
  )

  function reportReplacement(
    replacedCounts: ReadonlyMap<string, number>,
    unsavedFileCount: number,
    readOnlyFileCount: number,
    failures: readonly string[]
  ): void {
    const message = messageLatest.current
    const t = tLatest.current
    let matches = 0
    let fileCount = 0
    for (const count of replacedCounts.values()) {
      matches += count
      if (count > 0) fileCount += 1
    }
    if (matches > 0)
      message.success({
        title: t('workbench.projectSearchReplaced', {
          matches: formatWorkbenchProjectSearchCount(t, 'match', matches),
          files: formatWorkbenchProjectSearchCount(t, 'file', fileCount),
        }),
        description:
          unsavedFileCount > 0
            ? t('workbench.projectSearchReplacedUnsaved', {
                files: formatWorkbenchProjectSearchCount(t, 'file', unsavedFileCount),
              })
            : undefined,
      })
    if (readOnlyFileCount > 0)
      message.warning({
        title: t('workbench.projectSearchReplaceReadOnly', {
          files: formatWorkbenchProjectSearchCount(t, 'file', readOnlyFileCount),
        }),
      })
    if (failures.length > 0)
      message.warning({
        title: t('workbench.projectSearchReplaceFailed'),
        description: failures.join('\n'),
      })
  }

  const replaceAll = useMemoizedFn(async (): Promise<void> => {
    if (files.length === 0 || results.status !== 'done') return

    const t = tLatest.current
    const lines = [
      t('workbench.projectSearchReplaceAllConfirm', {
        matches: formatWorkbenchProjectSearchCount(t, 'match', summary.matchCount),
        files: formatWorkbenchProjectSearchCount(t, 'file', summary.fileCount),
        replacement,
      }),
    ]
    if (files.some((file) => file.source === 'editor')) lines.push(t('workbench.projectSearchReplaceAllOpenFiles'))
    if (results.truncated) lines.push(t('workbench.projectSearchReplaceAllTruncated'))
    if (!window.confirm(lines.join('\n\n'))) return

    await replaceTargets(
      files.map((file) => ({ file })),
      'all'
    )
  })

  /** 打开搜索（⇧⌘F、放大镜、右键菜单）：给了 seed 就拿它当查找词（正则模式下按字面转义）。 */
  const openPanel = useMemoizedFn((seed?: string): void => {
    if (seed) options.onQueryChange(searchOptions.regex ? escapeWorkbenchTextSearchRegExp(seed) : seed)
    setIsOpen(true)
    setFocusPending(true)
  })

  const closePanel = useMemoizedFn((): void => {
    setIsOpen(false)
    setFocusPending(false)
    options.onResetQuery()
  })

  const toggleOption = useMemoizedFn((option: keyof WorkbenchTextSearchOptions): void => {
    setSearchOptions((current) => ({ ...current, [option]: !current[option] }))
  })

  const toggleFileCollapsed = useMemoizedFn((path: string): void => {
    setCollapsedPaths((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  })

  const setAllFilesCollapsed = useMemoizedFn((collapsed: boolean): void => {
    setCollapsedPaths(collapsed ? new Set(files.map((file) => file.path)) : new Set())
  })

  // 交给界面的动作都是稳定的引用：结果行、表单按引用比较，不因为别的状态变了就整片重画。
  const actions = {
    acknowledgeFocus: useMemoizedFn((): void => setFocusPending(false)),
    togglePanel: useMemoizedFn((): void => (isOpen ? closePanel() : openPanel())),
    toggleReplace: useMemoizedFn((): void => setReplaceOpen((open) => !open)),
    toggleDetails: useMemoizedFn((): void => setDetailsOpen((open) => !open)),
    toggleEntriesCollapsed: useMemoizedFn((): void => setEntriesCollapsed((collapsed) => !collapsed)),
    refresh: useMemoizedFn((): void => void runSearch()),
    openMatch: useMemoizedFn(
      (file: WorkbenchProjectSearchFile, match: WorkbenchContentSearchMatchResult): void =>
        options.onOpenMatch(file.path, match)
    ),
    replaceMatch: useMemoizedFn(
      (file: WorkbenchProjectSearchFile, match: WorkbenchContentSearchMatchResult): void =>
        void replaceTargets([{ file, matches: [match] }], 'files')
    ),
    replaceFile: useMemoizedFn(
      (file: WorkbenchProjectSearchFile): void => void replaceTargets([{ file }], 'files')
    ),
    replaceAll: useMemoizedFn((): void => void replaceAll()),
  }

  return {
    ...actions,
    isOpen,
    /** 刚打开（或再按了一次 ⇧⌘F）：查找框要拿到焦点并全选。 */
    focusPending,
    openPanel,
    closePanel,
    options: searchOptions,
    toggleOption,
    regexError,
    replaceOpen,
    replacement,
    setReplacement,
    detailsOpen,
    include,
    setInclude,
    exclude,
    setExclude,
    /** 包含 / 排除的文件（也用来筛按文件名找到的条目）。 */
    pathFilter,
    files,
    summary,
    isSearching: results.status === 'searching' || (!!searchKey && results.status === 'idle'),
    truncated: results.truncated,
    skippedLargeFileCount: results.skippedLargeFileCount,
    collapsedPaths,
    toggleFileCollapsed,
    setAllFilesCollapsed,
    entriesCollapsed,
    isReplacing,
  }
}

export type WorkbenchProjectSearchModel = ReturnType<typeof useWorkbenchProjectSearchController>
