/**
 * 项目搜索与替换本身（随搜索面板 `ProjectSearchView` 按需加载）：按面板表单里的条件搜，收结果，替换。
 *
 * - 输入停一小会儿再搜；新的搜索开始时取消还没搜完的旧搜索；结果边搜边显示。面板卸下时取消。
 * - 每份结果记着搜它的条件（查找词、开关、范围）：编辑器里开着的文件按它在正文上算（正文一改结果跟着变），
 *   替换也按它——换的就是列出来的那些。条件改了、新结果还没出来之前，替换先不让点。
 * - 搜索中途失败（正则跑不完被 main 停下、出错）：已经到的结果留着，原因写在结果上方，结果不全、不让替换。
 * - 开着的文件以编辑器里的正文为准（见 workbenchProjectSearchModel）；开着的文件关掉了，就按磁盘重新搜它。
 * - 替换一处、一个文件或全部（全部先确认）：开着的文件在编辑器里换，能撤销、不写盘；其余的交给 main 写盘，
 *   写完刷新那几个文件的结果（全部替换后整个重搜）。
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import type { WorkbenchEditorOpenTabIntent } from '@renderer/models/editor/workbenchEditorGroups'
import {
  formatWorkbenchProjectSearchCount,
  mergeWorkbenchProjectSearchFiles,
  searchWorkbenchEditorText,
  summarizeWorkbenchProjectSearch,
  type WorkbenchProjectSearchFile,
} from '@renderer/models/files/workbenchProjectSearchModel'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type {
  WorkbenchContentSearchFileResult,
  WorkbenchContentSearchMatchResult,
  WorkbenchSearchContentBatch,
  WorkbenchSearchContentRequest,
} from '@shared/contracts'
import { normalizeWorkbenchTextEol } from '@shared/workbenchTextFormat'
import {
  compileWorkbenchTextSearch,
  previewWorkbenchTextSearchReplacement,
  replaceWorkbenchTextSearchMatches,
  WorkbenchContentSearchDefaultLimit,
  type WorkbenchTextSearchMatcher,
  type WorkbenchTextSearchOptions,
  workbenchTextSearchRangeKey,
} from '@shared/workbenchTextSearch'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMemoizedFn } from '../support/genericHooks'

import type { WorkbenchProjectSearchPanelModel } from './useWorkbenchProjectSearchPanel'

/** 输入停这么久再搜。 */
const SearchDebounceMs = 200
/** 一次最多列出的匹配数（main 与开着的文件各自按它截）。 */
export const WorkbenchProjectSearchLimit = WorkbenchContentSearchDefaultLimit

export interface WorkbenchProjectSearchReplaceTarget {
  file: WorkbenchProjectSearchFile
  /** 只换这几处；不给就换这个文件里的全部。 */
  matches?: readonly WorkbenchContentSearchMatchResult[]
}

export interface WorkbenchProjectSearchEngineOptions {
  /** 面板表单里的条件与替换文字。 */
  panel: Pick<WorkbenchProjectSearchPanelModel, 'options' | 'include' | 'exclude' | 'replacement'>
  /** 输入框里的查找词（原样，不去空白）。 */
  query: string
  projectRoot: string
  openTabs: readonly WorkbenchOpenEditorTab[]
  /** 在开着的标签上替换（见 useWorkbenchEditorController.replaceOpenTabContents）。 */
  replaceOpenTabContents: (
    changes: ReadonlyArray<{ path: string; replace: (content: string) => string }>
  ) => { replacedPaths: string[]; readOnlyPaths: string[] }
  /** 打开一处匹配：跳到那个文件，选中匹配。单击是预览标签，双击、回车是普通标签。 */
  onOpenMatch: (
    path: string,
    match: WorkbenchContentSearchMatchResult,
    intent?: WorkbenchEditorOpenTabIntent
  ) => void
}

/** 一次搜索的条件：结果按它算，替换也按它。 */
interface ProjectSearchSpec {
  /** 条件的指纹：输入框里的条件变了就对不上。 */
  key: string
  projectRoot: string
  query: string
  options: WorkbenchTextSearchOptions
  include: string
  exclude: string
  matcher: WorkbenchTextSearchMatcher
}

interface ProjectSearchResultsState {
  /** 这份结果属于哪一次搜索；推送、刷新按它认。 */
  generation: number
  spec: Nullable<ProjectSearchSpec>
  /**
   * 这份结果的搜索 id：推送按它认。搜完了也留着——推送与最后的返回走的不一定是同一条通道，晚到的一批照样
   * 并进来（每个文件只在一批里出现）。
   */
  searchId: Nullable<string>
  diskFiles: ReadonlyMap<string, WorkbenchContentSearchFileResult>
  /** 确认落在搜索范围里的路径：搜到的文件，加上报回来的开着的文件（它们以编辑器正文为准）。 */
  scopePaths: ReadonlySet<string>
  status: 'idle' | 'searching' | 'done'
  truncated: boolean
  skippedLargeFileCount: number
  /** 没搜完的原因（出错、正则跑不完被停下）：结果不全，界面上说明，也不让替换。 */
  failure: Nullable<string>
}

interface EditorResultCacheEntry {
  content: string
  matcher: WorkbenchTextSearchMatcher
  result: WorkbenchContentSearchFileResult
}

function emptyResults(generation: number): ProjectSearchResultsState {
  return {
    generation,
    spec: null,
    searchId: null,
    diskFiles: new Map(),
    scopePaths: new Set(),
    status: 'idle',
    truncated: false,
    skippedLargeFileCount: 0,
    failure: null,
  }
}

/** 开着的文件里能在编辑器正文上搜的：完整的文本（截断的大文件与图片交给磁盘搜索）。 */
function isSearchableOpenTab(tab: WorkbenchOpenEditorTab): boolean {
  return !tab.file.imagePreview && !tab.file.truncated
}

function specRequest(spec: ProjectSearchSpec): WorkbenchSearchContentRequest {
  return {
    projectRoot: spec.projectRoot,
    query: spec.query,
    ...spec.options,
    include: spec.include,
    exclude: spec.exclude,
    limit: WorkbenchProjectSearchLimit,
  }
}

export function useWorkbenchProjectSearchEngine(options: WorkbenchProjectSearchEngineOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const { panel, query, projectRoot } = options
  const [results, setResults] = useState<ProjectSearchResultsState>(() => emptyResults(0))
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [entriesCollapsed, setEntriesCollapsed] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const openTabsRef = useLatest(options.openTabs)
  const resultsRef = useLatest(results)
  const generationRef = useRef(0)
  const isReplacingRef = useRef(false)
  const editorResultCacheRef = useRef(new Map<string, EditorResultCacheEntry>())

  const compiled = useMemo(
    () => compileWorkbenchTextSearch({ query, ...panel.options }),
    [panel.options, query]
  )
  const regexError = compiled.status === 'invalid' ? compiled.message : null
  /** 输入框里的条件；查找词是空白、正则写错时为 null（不搜）。 */
  const spec = useMemo((): Nullable<ProjectSearchSpec> => {
    if (compiled.status !== 'ready' || !query.trim()) return null
    return {
      key: JSON.stringify([projectRoot, query, panel.options, panel.include, panel.exclude]),
      projectRoot,
      query,
      options: panel.options,
      include: panel.include,
      exclude: panel.exclude,
      matcher: compiled.matcher,
    }
  }, [compiled, panel.exclude, panel.include, panel.options, projectRoot, query])
  const specKey = spec?.key ?? null
  /** 列着的结果就是按输入框里的条件搜的，而且已经搜完。 */
  const resultsCurrent = !!spec && results.spec?.key === spec.key && results.status === 'done'
  /** 能替换的结果：搜完了，而且是搜全的（中途失败、正则跑不完被停下的不算）。 */
  const resultsReplaceable = resultsCurrent && !results.failure

  const cancelRunningSearch = useMemoizedFn((): void => {
    const { searchId, status } = resultsRef.current
    if (searchId && status === 'searching')
      void workbenchHost.kernel.project.cancelWorkbenchContentSearch({ searchId })
  })

  /** 按磁盘重搜几个文件（替换之后、开着的文件关掉之后），结果并回当前这份结果。 */
  const refreshPaths = useMemoizedFn(async (paths: readonly string[]): Promise<void> => {
    const { generation, spec: resultsSpec } = resultsRef.current
    if (!resultsSpec || paths.length === 0) return

    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.searchWorkbenchContent({
          ...specRequest(resultsSpec),
          paths: [...paths],
        })
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

  /** 收一批结果：搜到的文件与确认在范围里的开着的文件。已经关掉的开着的文件按磁盘重搜。 */
  const applyBatch = useMemoizedFn((generation: number, batch: WorkbenchSearchContentBatch): void => {
    if (resultsRef.current.generation !== generation) return
    setResults((current) => {
      if (current.generation !== generation) return current
      const diskFiles = new Map(current.diskFiles)
      const scopePaths = new Set(current.scopePaths)
      for (const file of batch.files) {
        diskFiles.set(file.path, file)
        scopePaths.add(file.path)
      }
      for (const path of batch.openPathsInScope) scopePaths.add(path)
      return { ...current, diskFiles, scopePaths }
    })

    const openPaths = new Set(openTabsRef.current.filter(isSearchableOpenTab).map((tab) => tab.path))
    const closed = batch.openPathsInScope.filter((path) => !openPaths.has(path))
    if (closed.length > 0) void refreshPaths(closed)
  })

  /** 按输入框里的条件重新搜。 */
  const runSearch = useMemoizedFn(async (): Promise<void> => {
    cancelRunningSearch()
    generationRef.current += 1
    const generation = generationRef.current
    if (!spec) {
      setResults(emptyResults(generation))
      return
    }

    const searchId = crypto.randomUUID()
    const started: ProjectSearchResultsState = {
      ...emptyResults(generation),
      spec,
      searchId,
      status: 'searching',
    }
    // 推送可能在下一次渲染之前就到：先让 ref 认出这次搜索。
    resultsRef.current = started
    setResults(started)
    setCollapsedPaths(new Set())
    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.searchWorkbenchContent({
          ...specRequest(spec),
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
              status: 'done',
              truncated: result.truncated,
              skippedLargeFileCount: result.skippedLargeFileCount,
            }
      )
    } catch (error) {
      if (generationRef.current !== generation) return
      // 已经到的结果留着，原因写在结果上方（见 ProjectSearchSummary）。
      const failure = AppError.from(error).message
      setResults((current) =>
        current.generation !== generation ? current : { ...current, status: 'done', failure }
      )
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

  // 条件一变就重搜（停一小会儿，打字时不每个键都搜）；条件没了（清空、正则写错）就收起结果。
  useEffect(() => {
    if (!specKey) {
      cancelRunningSearch()
      generationRef.current += 1
      setResults(emptyResults(generationRef.current))
      return undefined
    }

    const timer = setTimeout(() => void runSearch(), SearchDebounceMs)
    return () => clearTimeout(timer)
  }, [cancelRunningSearch, runSearch, specKey])

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

  // 开着的、在范围里的文件按这份结果的条件在编辑器正文上搜；正文没变的沿用上次的结果。按推迟的标签算：
  // 在大文件里打字时先让编辑器跟手，结果稍后跟上。
  const resultsMatcher = results.spec?.matcher ?? null
  const deferredOpenTabs = useDeferredValue(options.openTabs)
  const editorFiles = useMemo(() => {
    const files = new Map<string, WorkbenchContentSearchFileResult>()
    const cache = editorResultCacheRef.current
    if (!resultsMatcher) {
      cache.clear()
      return files
    }

    for (const tab of deferredOpenTabs) {
      if (!isSearchableOpenTab(tab) || !results.scopePaths.has(tab.path)) continue
      const cached = cache.get(tab.path)
      const result =
        cached && cached.content === tab.content && cached.matcher === resultsMatcher
          ? cached.result
          : searchWorkbenchEditorText({
              path: tab.path,
              content: tab.content,
              modifiedAt: tab.file.modifiedAt,
              size: tab.file.size,
              matcher: resultsMatcher,
              limit: WorkbenchProjectSearchLimit,
            })
      cache.set(tab.path, { content: tab.content, matcher: resultsMatcher, result })
      files.set(tab.path, result)
    }
    for (const path of [...cache.keys()]) if (!files.has(path)) cache.delete(path)
    return files
  }, [deferredOpenTabs, results.scopePaths, resultsMatcher])

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
      const resultsSpec = resultsRef.current.spec
      if (!resultsSpec || !resultsReplaceable || targets.length === 0 || isReplacingRef.current)
        return

      isReplacingRef.current = true
      setIsReplacing(true)
      const text = panel.replacement
      const { matcher } = resultsSpec
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
              // 替换文字里的 `\r` 与编辑器一样当换行：编辑缓冲一律是 LF。
              return normalizeWorkbenchTextEol(replaced.content)
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
              projectRoot: resultsSpec.projectRoot,
              query: resultsSpec.query,
              ...resultsSpec.options,
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
        // 替换过的文件等刷新拿回新版本再放开替换按钮：不然紧接着再点一次会拿旧版本去换，被当成外部改过。
        if (refresh === 'all') void runSearch()
        else await refreshPaths([...diskTargets.map((target) => target.file.path), ...vanishedPaths])
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

  const confirmReplaceAll = useMemoizedFn(async (): Promise<void> => {
    if (files.length === 0 || !resultsReplaceable) return

    const t = tLatest.current
    const lines = [
      t('workbench.projectSearchReplaceAllConfirm', {
        matches: formatWorkbenchProjectSearchCount(t, 'match', summary.matchCount),
        files: formatWorkbenchProjectSearchCount(t, 'file', summary.fileCount),
        replacement: panel.replacement,
      }),
    ]
    if (files.some((file) => file.source === 'editor'))
      lines.push(t('workbench.projectSearchReplaceAllOpenFiles'))
    if (results.truncated) lines.push(t('workbench.projectSearchReplaceAllTruncated'))
    if (!window.confirm(lines.join('\n\n'))) return

    await replaceTargets(
      files.map((file) => ({ file })),
      'all'
    )
  })

  // 交给界面的动作都是稳定的引用：结果行、表单按引用比较，不因为别的状态变了就整片重画。
  const actions = {
    toggleFileCollapsed: useMemoizedFn((path: string): void => {
      setCollapsedPaths((current) => {
        const next = new Set(current)
        if (!next.delete(path)) next.add(path)
        return next
      })
    }),
    setAllFilesCollapsed: useMemoizedFn((collapsed: boolean): void => {
      setCollapsedPaths(collapsed ? new Set(files.map((file) => file.path)) : new Set())
    }),
    toggleEntriesCollapsed: useMemoizedFn((): void => setEntriesCollapsed((collapsed) => !collapsed)),
    refresh: useMemoizedFn((): void => void runSearch()),
    openMatch: useMemoizedFn(
      (
        file: WorkbenchProjectSearchFile,
        match: WorkbenchContentSearchMatchResult,
        intent?: WorkbenchEditorOpenTabIntent
      ): void => options.onOpenMatch(file.path, match, intent)
    ),
    /** 结果行里预览的替换文字（正则按匹配本身算捕获组）。 */
    previewReplacement: useMemoizedFn((matchedText: string): string =>
      resultsMatcher
        ? previewWorkbenchTextSearchReplacement(resultsMatcher, panel.replacement, matchedText)
        : panel.replacement
    ),
    replaceMatch: useMemoizedFn(
      (file: WorkbenchProjectSearchFile, match: WorkbenchContentSearchMatchResult): void =>
        void replaceTargets([{ file, matches: [match] }], 'files')
    ),
    replaceFile: useMemoizedFn(
      (file: WorkbenchProjectSearchFile): void => void replaceTargets([{ file }], 'files')
    ),
    replaceAll: useMemoizedFn((): void => void confirmReplaceAll()),
  }

  return {
    ...actions,
    /** 正则写错时的说明。 */
    regexError,
    files,
    summary,
    /** 第几份结果：每次重新搜加一（换了一份结果，列表回到顶上）。 */
    resultsGeneration: results.generation,
    /** 正在搜，或者条件变了、新结果还没出来。 */
    isSearching: !!spec && !resultsCurrent,
    truncated: results.truncated,
    skippedLargeFileCount: results.skippedLargeFileCount,
    /** 这次搜索没搜完的原因；列着的是出事之前搜到的。 */
    failure: resultsCurrent ? results.failure : null,
    collapsedPaths,
    entriesCollapsed,
    /** 能不能替换：结果就是输入框里的条件搜出来的、搜完也搜全了，也没有替换在进行。 */
    canReplace: resultsReplaceable && !isReplacing,
  }
}

export type WorkbenchProjectSearchEngine = ReturnType<typeof useWorkbenchProjectSearchEngine>
