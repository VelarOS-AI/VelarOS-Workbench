/**
 * 项目搜索面板（不进工作区外壳包，由 FilePanel 在空闲时预先加载）：表单、结果上方的一行、结果列表；查找词是
 * 空白时下面照样是文件树。搜索与替换本身在 useWorkbenchProjectSearchEngine 里：面板收起或切到别的左侧面板时停下，回来按
 * 表单里的条件重新搜。
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useWorkbenchDensity } from '@renderer/hooks/useWorkbenchPreferences'
import {
  useWorkbenchProjectSearchEngine,
  type WorkbenchProjectSearchEngineOptions,
} from '@renderer/hooks/useWorkbenchProjectSearchEngine'
import type { WorkbenchProjectSearchPanelModel } from '@renderer/hooks/useWorkbenchProjectSearchPanel'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchEditorOpenTabIntent } from '@renderer/models/editor/workbenchEditorGroups'
import { getWorkbenchFileSearchKeyboardAction } from '@renderer/models/files/workbenchFileSearchNavigationModel'
import {
  buildWorkbenchProjectSearchRows,
  isOpenableWorkbenchProjectSearchRow,
  type WorkbenchProjectSearchRow,
} from '@renderer/models/files/workbenchProjectSearchModel'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import { getWorkbenchFileTreeRowHeight } from '@renderer/models/settings/workbenchPreferences'

import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { WorkbenchDirectoryEntry, WorkbenchSearchEntriesResult } from '@shared/contracts'
import {
  compileWorkbenchSearchPathFilter,
  isWorkbenchSearchPathIncluded,
} from '@shared/workbenchSearchGlob'

import styles from '../../styles/workbenchPageStyles'

import { FileSearchResults } from './FileSearchResults'
import { ProjectSearchForm, ProjectSearchSummary } from './ProjectSearchForm'

export interface ProjectSearchViewProps
  extends Omit<WorkbenchProjectSearchEngineOptions, 'panel' | 'query'> {
  panel: WorkbenchProjectSearchPanelModel
  /** 输入框里的查找词（原样）。 */
  query: string
  onQueryChange: (query: string) => void
  /** 查找词不是空白：结果盖住文件树。 */
  searchActive: boolean
  /** 按文件名找到的条目。 */
  searchResult: Nullable<WorkbenchSearchEntriesResult>
  gitDecorations: WorkbenchGitDecorationMap
  selectedEntryPath: Nullable<string>
  onOpenEntry: (entry: WorkbenchDirectoryEntry, intent?: WorkbenchEditorOpenTabIntent) => void
  /** 查找词是空白时显示的文件树。 */
  tree: ReactNode
  /** 结果与文件树共用的滚动容器（FilePanel 靠它认焦点在不在树里）。 */
  scrollRef: RefObject<Nullable<HTMLDivElement>>
  onRootContextMenu: (event: MouseEvent) => void
  onEntryContextMenu: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
}

export function ProjectSearchView({
  panel,
  query,
  onQueryChange,
  searchActive,
  searchResult,
  gitDecorations,
  selectedEntryPath,
  onOpenEntry,
  tree,
  scrollRef,
  onRootContextMenu,
  onEntryContextMenu,
  ...engineOptions
}: ProjectSearchViewProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const engine = useWorkbenchProjectSearchEngine({ ...engineOptions, panel, query })
  const rowHeight = getWorkbenchFileTreeRowHeight(useWorkbenchDensity())
  const [activeRowKey, setActiveRowKey] = useState<Nullable<string>>(null)
  // 按文件名找到的条目也按「包含 / 排除的文件」筛。
  const pathFilter = useMemo(
    () => compileWorkbenchSearchPathFilter(panel.include, panel.exclude),
    [panel.exclude, panel.include]
  )
  const entries = useMemo(
    () =>
      (searchResult?.entries ?? []).filter((entry) =>
        isWorkbenchSearchPathIncluded(pathFilter, entry.path)
      ),
    [pathFilter, searchResult]
  )
  const rows = useMemo(
    () =>
      buildWorkbenchProjectSearchRows({
        entries,
        entriesCollapsed: engine.entriesCollapsed,
        files: engine.files,
        collapsedPaths: engine.collapsedPaths,
      }),
    [engine.collapsedPaths, engine.entriesCollapsed, engine.files, entries]
  )
  const openableRows = useMemo(() => rows.filter(isOpenableWorkbenchProjectSearchRow), [rows])
  // 挑中的行不在了（新的结果、收起了文件）就回到第一行。
  const activeRow = openableRows.find((row) => row.key === activeRowKey) ?? openableRows[0]

  // 换了一份搜索结果：列表回到顶上，挑中的行回到第一行。
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setActiveRowKey(null)
  }, [engine.resultsGeneration, scrollRef])

  /** 结果只渲染视野里的行：键盘挑中的行在视野外时把滚动条挪过去。 */
  function scrollRowIntoView(key: string): void {
    const scroll = scrollRef.current
    const index = rows.findIndex((row) => row.key === key)
    if (!scroll || index === -1) return

    const top = index * rowHeight
    if (top < scroll.scrollTop) scroll.scrollTop = top
    else if (top + rowHeight > scroll.scrollTop + scroll.clientHeight)
      scroll.scrollTop = top + rowHeight - scroll.clientHeight
  }

  /** 回车打开挑中的那一行：开成普通标签（单击才是预览）。 */
  function openRow(row: WorkbenchProjectSearchRow): void {
    if (row.kind === 'entry') onOpenEntry(row.entry)
    else if (row.kind === 'match') engine.openMatch(row.file, row.match)
  }

  /** 查找框里的上下键在结果里挑行，回车打开挑中的那一行；用掉了按键返回 true。 */
  function handleNavigationKey(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
    const activeIndex = activeRow ? openableRows.indexOf(activeRow) : 0
    const action = getWorkbenchFileSearchKeyboardAction(event.key, activeIndex, openableRows.length)
    if (!action) return false

    if (action.kind === 'set-active') {
      const row = openableRows[action.index]
      if (row) {
        setActiveRowKey(row.key)
        scrollRowIntoView(row.key)
      }
      return true
    }

    if (activeRow) openRow(activeRow)
    return true
  }

  return (
    <>
      <ProjectSearchForm
        query={query}
        panel={panel}
        engine={engine}
        onQueryChange={(nextQuery) => {
          setActiveRowKey(null)
          onQueryChange(nextQuery)
        }}
        onQueryNavigationKey={handleNavigationKey}
      />
      {searchActive && <ProjectSearchSummary engine={engine} />}
      <div className={styles.filePanelBody}>
        <ScrollArea
          ref={scrollRef}
          className={styles.treeScroll}
          aria-label={t('workbench.files')}
          onContextMenu={onRootContextMenu}
        >
          {searchActive ? (
            <FileSearchResults
              rows={rows}
              rowHeight={rowHeight}
              scrollRef={scrollRef}
              activeRowKey={activeRow?.key ?? null}
              gitDecorations={gitDecorations}
              selectedEntryPath={selectedEntryPath}
              previewReplacement={panel.replaceOpen ? engine.previewReplacement : null}
              replaceDisabled={!engine.canReplace}
              onActivateRow={setActiveRowKey}
              onToggleEntries={engine.toggleEntriesCollapsed}
              onToggleFile={engine.toggleFileCollapsed}
              onOpenEntry={onOpenEntry}
              onOpenMatch={engine.openMatch}
              onReplaceFile={engine.replaceFile}
              onReplaceMatch={engine.replaceMatch}
              onContextMenuEntry={onEntryContextMenu}
            />
          ) : (
            tree
          )}
        </ScrollArea>
      </div>
    </>
  )
}
