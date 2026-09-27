import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowClockwiseIcon,
  ChatCircleTextIcon,
  CopyIcon,
  FilePlusIcon,
  FolderPlusIcon,
  HammerIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import { isWorkbenchVelarFilePath } from '@renderer/models/commands/workbenchVelarFileCommand'
import type { WorkbenchContentSearchMatch } from '@renderer/models/files/workbenchContentSearchModel'
import {
  buildWorkbenchFileSearchNavigationItems,
  getWorkbenchFileSearchKeyboardAction,
  type WorkbenchFileSearchNavigationItem,
} from '@renderer/models/files/workbenchFileSearchNavigationModel'
import { getWorkbenchFileTreeShortcutAction } from '@renderer/models/files/workbenchTreeMutation'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import { ROOT_PATH } from '@renderer/models/shared/workbenchUtils'

import { toNullable } from '@velaros-ai/core'
import { currentPlatform as systemPlatformCompatibility } from '@velaros-ai/core/platform'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { WorkbenchDirectoryEntry, WorkbenchSearchEntriesResult } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { requestScrollIntoView } from '../../support/scrollUtils'
import { WorkbenchContextMenu } from '../chrome/WorkbenchContextMenu'

import { FileSearchResults } from './FileSearchResults'
import {
  createTreeEntry,
  deleteSelectedTreeEntries,
  FileTree,
  type FileTreeApi,
  isTreeEntryInMultiSelection,
  resolveTreeChatFilePaths,
} from './FileTree'

export interface WorkbenchFilePanelTreeProps {
  project: WorkbenchProject
  rootEntries: WorkbenchDirectoryEntry[]
  selectedEntryPath: Nullable<string>
  /** 定位请求的计数（见 useWorkbenchTreeController）：变了就把选中项滚进视野。 */
  revealRevision: number
  expandedPaths: Set<string>
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
  isLoadingTree: boolean
  isMutatingTree: boolean
  gitDecorations: WorkbenchGitDecorationMap
}

export interface WorkbenchFilePanelSearchProps {
  searchQuery: string
  normalizedSearchQuery: string
  searchResult: Nullable<WorkbenchSearchEntriesResult>
  contentSearchMatches: WorkbenchContentSearchMatch[]
  searchActive: boolean
  isSearchingEntries: boolean
  isIndexingProject: boolean
}

export interface WorkbenchFilePanelHandlersProps {
  onSelectEntryPath: (path: Nullable<string>) => void
  onCreateEntry: (
    type: WorkbenchDirectoryEntry['type'],
    parentEntry: Nullable<WorkbenchDirectoryEntry>,
    name: string
  ) => Promise<Nullable<WorkbenchDirectoryEntry>>
  onRenameEntry: (
    entry: WorkbenchDirectoryEntry,
    name: string
  ) => Promise<Nullable<WorkbenchDirectoryEntry>>
  onDeleteEntries: (entries: WorkbenchDirectoryEntry[]) => Promise<void>
  onUndoDeleteEntries: () => Promise<void>
  onMoveEntries: (
    entries: WorkbenchDirectoryEntry[],
    parentEntry: Nullable<WorkbenchDirectoryEntry>,
    index: number
  ) => Promise<void>
  onSearchQueryChange: (query: string) => void
  onResetSearch: () => void
  onRefreshProject: () => void
  onCloseProject?: () => void
  onOpenSearchEntry: (entry: WorkbenchDirectoryEntry) => void
  onOpenContentSearchMatch: (match: WorkbenchContentSearchMatch) => void
  onSetDirectoryOpen: (path: string, open: boolean) => void
  onSelectFile: (path: string) => void
  onRunFile?: (path: string) => void
  onBuildFile?: (path: string) => void
  /** 右键「添加到聊天」：把文件作为引用挂到聊天输入框（只挂路径，一次可以挂一组多选的文件）。 */
  onAddFilesToChat?: (paths: readonly string[]) => void
}

export function resolveWorkbenchEntryAbsolutePath(projectRoot: string, entryPath: string): string {
  return entryPath === ROOT_PATH
    ? projectRoot
    : systemPlatformCompatibility.joinPathText(projectRoot, entryPath)
}

interface FilePanelProps {
  tree: WorkbenchFilePanelTreeProps
  search: WorkbenchFilePanelSearchProps
  handlers: WorkbenchFilePanelHandlersProps
}

export function FilePanel({
  tree: {
    project,
    rootEntries,
    selectedEntryPath,
    revealRevision,
    expandedPaths,
    childrenByPath,
    isLoadingTree,
    isMutatingTree,
    gitDecorations,
  },
  search: {
    searchQuery,
    normalizedSearchQuery,
    searchResult,
    contentSearchMatches,
    searchActive,
    isSearchingEntries,
    isIndexingProject,
  },
  handlers: {
    onSelectEntryPath,
    onCreateEntry,
    onRenameEntry,
    onDeleteEntries,
    onUndoDeleteEntries,
    onMoveEntries,
    onSearchQueryChange,
    onResetSearch,
    onRefreshProject,
    onOpenSearchEntry,
    onOpenContentSearchMatch,
    onSetDirectoryOpen,
    onSelectFile,
    onRunFile,
    onBuildFile,
    onAddFilesToChat,
  },
}: FilePanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const filePanelRef = useRef<HTMLElement>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const treeApiRef = useRef<FileTreeApi>(null)
  const [isSearchVisible, setIsSearchVisible] = useState(false)
  const [contextMenu, setContextMenu] = useState<
    LooseOptional<{
      x: number
      y: number
      entry: WorkbenchDirectoryEntry
      /** 「添加到聊天」要挂的文件：右键时就定下来，点在多选里是整组里的文件。 */
      chatFilePaths: string[]
    }>
  >(null)
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0)
  const searchEntries = searchResult?.entries ?? []
  const rootTreeEntry = useMemo(
    () =>
      ({
        name: project.name,
        path: ROOT_PATH,
        type: 'directory',
        size: null,
        modifiedAt: null,
        hasChildren: true,
      }) satisfies WorkbenchDirectoryEntry,
    [project.name]
  )
  const searchNavigationItems = useMemo(
    () => buildWorkbenchFileSearchNavigationItems(searchEntries, contentSearchMatches),
    [contentSearchMatches, searchEntries]
  )
  const activeSearchResultId = toNullable(searchNavigationItems[activeSearchResultIndex]?.id)

  const handleTreeApiChange = useCallback((api: Nullable<FileTreeApi>): void => {
    treeApiRef.current = api || null
  }, [])

  useEffect(() => {
    if (activeSearchResultIndex >= searchNavigationItems.length) {
      setActiveSearchResultIndex(Math.max(0, searchNavigationItems.length - 1))
    }
  }, [activeSearchResultIndex, searchNavigationItems.length])

  useEffect(() => {
    function isEditableShortcutTarget(target: Nullable<EventTarget>): boolean {
      return (
        target instanceof HTMLElement &&
        !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
      )
    }

    function handleFilePanelKeyDown(event: KeyboardEvent): void {
      const panel = filePanelRef.current
      if (!panel) return

      const targetNode = event.target instanceof Node ? event.target : null
      const activeElement = document.activeElement
      const targetInside = targetNode ? panel.contains(targetNode) : false
      const focusInside = activeElement ? panel.contains(activeElement) : false
      if (!targetInside && !focusInside) return

      if (isEditableShortcutTarget(event.target)) return

      const action = getWorkbenchFileTreeShortcutAction(event)
      if (!action) return

      event.preventDefault()
      event.stopPropagation()

      if (action === 'delete-selected') {
        const treePanel = treeScrollRef.current
        const treeTargetInside = !!(targetNode && treePanel?.contains(targetNode))
        const treeFocusInside = !!(activeElement && treePanel?.contains(activeElement))
        if (!searchActive && (treeTargetInside || treeFocusInside)) {
          deleteSelectedTreeEntries(treeApiRef.current)
        }
        return
      }

      void onUndoDeleteEntries()
    }

    window.addEventListener('keydown', handleFilePanelKeyDown, true)
    return () => window.removeEventListener('keydown', handleFilePanelKeyDown, true)
  }, [onUndoDeleteEntries, searchActive])

  function openContextMenu(entry: WorkbenchDirectoryEntry, event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    // 右键点在一组多选里时保留这组选择（菜单里的「添加到聊天」作用于整组），否则选中右键的这一项。
    if (!isTreeEntryInMultiSelection(treeApiRef.current, entry.path)) onSelectEntryPath(entry.path)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entry,
      chatFilePaths: resolveTreeChatFilePaths(treeApiRef.current, entry),
    })
  }

  function openRootContextMenu(event: MouseEvent): void {
    if (event.target instanceof HTMLElement && event.target.closest('button, [data-tree-path]'))
      return

    event.preventDefault()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entry: rootTreeEntry,
      chatFilePaths: [],
    })
  }

  function toggleSearch(): void {
    setIsSearchVisible((visible) => {
      if (visible) {
        onResetSearch()
      }
      setActiveSearchResultIndex(0)
      return !visible
    })
  }

  // 右键的那一项决定落在哪个目录（根目录与空白处的菜单对应工程根），不看树里当前聚焦或选中的是谁。
  function createEntryFromContext(type: WorkbenchDirectoryEntry['type']): void {
    if (!contextMenu) return

    void createTreeEntry({
      treeRef: treeApiRef,
      type,
      anchorEntry: contextMenu.entry,
      childrenByPath,
      onCreateEntry,
    })
  }

  function scrollSearchResultIntoView(id: string): void {
    requestScrollIntoView(
      () =>
        treeScrollRef.current?.querySelector<HTMLButtonElement>(
          `[data-search-result-id="${CSS.escape(id)}"]`
        ),
      { block: 'nearest', behavior: 'auto' }
    )
  }

  function setActiveSearchResult(index: number): void {
    setActiveSearchResultIndex(index)
    const nextId = searchNavigationItems[index]?.id
    if (nextId) {
      scrollSearchResultIntoView(nextId)
    }
  }

  function openSearchNavigationItem(item: WorkbenchFileSearchNavigationItem): void {
    if (item.kind === 'entry') {
      onOpenSearchEntry(item.entry)
      return
    }

    onOpenContentSearchMatch(item.match)
  }

  function handleSearchInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      toggleSearch()
      return
    }

    const action = getWorkbenchFileSearchKeyboardAction(
      event.key,
      activeSearchResultIndex,
      searchNavigationItems.length
    )
    if (!action) return

    event.preventDefault()
    if (action.kind === 'set-active') {
      setActiveSearchResult(action.index)
      return
    }

    const item = searchNavigationItems[activeSearchResultIndex]
    if (item) {
      openSearchNavigationItem(item)
    }
  }

  return (
    <aside ref={filePanelRef} className={styles.filePanel}>
      <div
        className={styles.filePanelProjectHeader}
        title={project.rootPath}
        onContextMenu={openRootContextMenu}
      >
        <span className={styles.filePanelViewTitle}>{t('workbench.projectView')}</span>
        <IconButton
          variant="ghost"
          size="icon-sm"
          className={styles.filePanelProjectAction}
          title={t('workbench.searchFiles')}
          label={t('workbench.searchFiles')}
          data-active={isSearchVisible || undefined}
          onClick={toggleSearch}
        >
          <MagnifyingGlassIcon size={14} />
        </IconButton>
      </div>
      {isSearchVisible && (
        <div className={styles.searchBar}>
          <div className={styles.searchInputShell}>
            <SearchField
              size="sm"
              value={searchQuery}
              autoFocus
              placeholder={t('workbench.projectSearchPlaceholder')}
              onChange={(event) => {
                setActiveSearchResultIndex(0)
                onSearchQueryChange(event.target.value)
              }}
              onKeyDown={handleSearchInputKeyDown}
            />
          </div>
        </div>
      )}
      <div className={styles.filePanelBody}>
        <ScrollArea
          ref={treeScrollRef}
          className={styles.treeScroll}
          aria-label={t('workbench.files')}
          onContextMenu={openRootContextMenu}
        >
          {searchActive ? (
            <FileSearchResults
              activeSearchResultId={activeSearchResultId}
              contentSearchMatches={contentSearchMatches}
              gitDecorations={gitDecorations}
              isIndexingProject={isIndexingProject}
              isSearchingEntries={isSearchingEntries}
              searchEntries={searchEntries}
              searchResult={searchResult}
              searchQuery={searchQuery}
              selectedEntryPath={selectedEntryPath}
              onActivateSearchResult={setActiveSearchResultIndex}
              onContextMenuEntry={openContextMenu}
              onOpenContentSearchMatch={onOpenContentSearchMatch}
              onOpenSearchEntry={onOpenSearchEntry}
            />
          ) : (
            <>
              <FileTree
                entries={rootEntries}
                selectedPath={selectedEntryPath}
                revealRevision={revealRevision}
                expandedPaths={expandedPaths}
                childrenByPath={childrenByPath}
                gitDecorations={gitDecorations}
                searchTerm={!searchActive && isSearchVisible ? normalizedSearchQuery : ''}
                isMutatingTree={isMutatingTree}
                onTreeApiChange={handleTreeApiChange}
                onSetDirectoryOpen={onSetDirectoryOpen}
                onSelectEntryPath={onSelectEntryPath}
                onSelectFile={onSelectFile}
                onContextMenuEntry={openContextMenu}
                onRenameEntry={onRenameEntry}
                onDeleteEntries={onDeleteEntries}
                onMoveEntries={onMoveEntries}
              />
              {!rootEntries.length && !isLoadingTree && (
                <Paragraph spacing="none" tone="secondary" className={styles.panelEmpty}>
                  {t('workbench.noFiles')}
                </Paragraph>
              )}
            </>
          )}
        </ScrollArea>
      </div>
      {!!contextMenu && (
        <WorkbenchContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={contextMenu.entry.name}
          compact
          onDismiss={() => setContextMenu(null)}
          items={[
            ...(contextMenu.chatFilePaths.length > 0
              ? [
                  {
                    id: 'add-to-chat',
                    label:
                      contextMenu.chatFilePaths.length > 1
                        ? t('workbench.addFilesToChat', { count: contextMenu.chatFilePaths.length })
                        : t('workbench.editorContextAddToChat'),
                    icon: <ChatCircleTextIcon size={14} />,
                    disabled: !onAddFilesToChat,
                    onSelect: () => onAddFilesToChat?.(contextMenu.chatFilePaths),
                  },
                ]
              : []),
            ...(contextMenu.entry.type === 'file'
              && isWorkbenchVelarFilePath(contextMenu.entry.path)
              ? [
                  {
                    id: 'run-file',
                    label: t('workbench.editorContextRun'),
                    icon: <PlayIcon size={14} />,
                    separatorBefore: contextMenu.chatFilePaths.length > 0,
                    disabled: !onRunFile,
                    onSelect: () => onRunFile?.(contextMenu.entry.path),
                  },
                  {
                    id: 'build-file',
                    label: t('workbench.editorContextBuild'),
                    icon: <HammerIcon size={14} />,
                    disabled: !onBuildFile,
                    onSelect: () => onBuildFile?.(contextMenu.entry.path),
                  },
                ]
              : []),
            {
              id: 'create-file',
              label: t('workbench.createFile'),
              icon: <FilePlusIcon size={14} />,
              separatorBefore:
                contextMenu.chatFilePaths.length > 0
                || (contextMenu.entry.type === 'file'
                  && isWorkbenchVelarFilePath(contextMenu.entry.path)),
              disabled: isMutatingTree,
              onSelect: () => createEntryFromContext('file'),
            },
            {
              id: 'create-directory',
              label: t('workbench.createDirectory'),
              icon: <FolderPlusIcon size={14} />,
              disabled: isMutatingTree,
              onSelect: () => createEntryFromContext('directory'),
            },
            {
              id: 'search-project',
              label: t('workbench.searchFiles'),
              icon: <MagnifyingGlassIcon size={14} />,
              separatorBefore: true,
              onSelect: () => {
                setActiveSearchResultIndex(0)
                setIsSearchVisible(true)
              },
            },
            {
              id: 'refresh-project',
              label: t('workbench.refreshFiles'),
              icon: <ArrowClockwiseIcon size={14} />,
              disabled: isLoadingTree || isMutatingTree,
              onSelect: onRefreshProject,
            },
            {
              id: 'copy-relative-path',
              label: t('workbench.copyRelativePath'),
              icon: <CopyIcon size={14} />,
              disabled: contextMenu.entry.path === ROOT_PATH,
              separatorBefore: true,
              onSelect: () => navigator.clipboard.writeText(contextMenu.entry.path),
            },
            {
              id: 'copy-absolute-path',
              label: t('workbench.copyAbsolutePath'),
              icon: <CopyIcon size={14} />,
              onSelect: () =>
                navigator.clipboard.writeText(
                  resolveWorkbenchEntryAbsolutePath(project.rootPath, contextMenu.entry.path)
                ),
            },
            {
              id: 'rename',
              label: t('workbench.renameEntry'),
              icon: <PencilSimpleIcon size={14} />,
              disabled: isMutatingTree || contextMenu.entry.path === ROOT_PATH,
              separatorBefore: true,
              onSelect: () => {
                void treeApiRef.current?.edit(contextMenu.entry.path)
              },
            },
            {
              id: 'delete',
              label: t('workbench.deleteEntry'),
              icon: <TrashIcon size={14} />,
              disabled: isMutatingTree || contextMenu.entry.path === ROOT_PATH,
              onSelect: () => {
                void treeApiRef.current?.delete([contextMenu.entry.path])
              },
            },
          ]}
        />
      )}
    </aside>
  )
}
