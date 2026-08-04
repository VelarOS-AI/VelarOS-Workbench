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
  CopyIcon,
  FilePlusIcon,
  FolderPlusIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  SpinnerGapIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
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
import { currentSystemPlatform as systemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type {
  SystemWorkspaceGitSummary,
  WorkbenchDirectoryEntry,
  WorkbenchSearchEntriesResult,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { requestScrollIntoView } from '../../support/scrollUtils'
import { WorkbenchContextMenu } from '../chrome/WorkbenchContextMenu'

import { FileSearchResults } from './FileSearchResults'
import {
  deleteSelectedTreeEntries,
  FileTree,
  type FileTreeApi,
} from './FileTree'

export interface WorkbenchFilePanelTreeProps {
  project: WorkbenchProject
  rootEntries: WorkbenchDirectoryEntry[]
  selectedEntryPath: Nullable<string>
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
}

/**
 * 片4 前的过渡形态：desktop 的分支/提交控件（WorkspaceGitCommitControl）属 git 面，
 * 独立宿主在 git 服务落地前不随迁——variant/layout 先以字面量联合占位（值域同源），
 * 片4 复活控件时替换回组件导出的类型。
 */
export type WorkspaceGitCommitControlVariant = 'branch-menu-actions' | 'inline-actions'
export type WorkspaceGitCommitControlLayout = 'segmented' | 'pill'

export interface WorkbenchFilePanelGitControlProps {
  sessionId: string
  summary: Nullable<SystemWorkspaceGitSummary>
  onRefresh: () => Promise<void>
  gitSshKeyPath?: string
  hasRepository: boolean
  hasUnsavedOpenTabs: boolean
  variant?: WorkspaceGitCommitControlVariant
  layout?: WorkspaceGitCommitControlLayout
  onRepositoryChanged: () => void | Promise<void>
  onInitializeRepository: () => Promise<void> | void
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
  git?: WorkbenchFilePanelGitControlProps
}

export function FilePanel({
  tree: {
    project,
    rootEntries,
    selectedEntryPath,
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
    onCloseProject,
    onOpenSearchEntry,
    onOpenContentSearchMatch,
    onSetDirectoryOpen,
    onSelectFile,
  },
  git,
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
    }>
  >(null)
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0)
  const [initializingRepository, setInitializingRepository] = useState(false)
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
  const treeRootEntries = useMemo(() => [rootTreeEntry], [rootTreeEntry])
  const treeChildrenByPath = useMemo(() => {
    const next = new Map(childrenByPath)
    next.set(ROOT_PATH, rootEntries)
    return next
  }, [childrenByPath, rootEntries])
  const searchNavigationItems = useMemo(
    () => buildWorkbenchFileSearchNavigationItems(searchEntries, contentSearchMatches),
    [contentSearchMatches, searchEntries]
  )
  const activeSearchResultId = toNullable(searchNavigationItems[activeSearchResultIndex]?.id)
  const gitControlReady =
    !!git?.hasRepository && !!git.summary?.repository && !!git.summary.status?.branch

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
    onSelectEntryPath(entry.path)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entry,
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

  function clearSearchInput(): void {
    setActiveSearchResultIndex(0)
    onResetSearch()
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

  async function handleInitializeRepository(): Promise<void> {
    if (!git || initializingRepository) return

    setInitializingRepository(true)
    try {
      await git.onInitializeRepository()
    } finally {
      setInitializingRepository(false)
    }
  }

  return (
    <aside ref={filePanelRef} className={styles.filePanel}>
      <div className={styles.panelHeader}>
        {git ? (
          <div className={styles.filePanelGitControl}>
            {gitControlReady ? (
              /* 片4 复活 WorkspaceGitCommitControl 前的降级投影：只读分支名。 */
              <span className={styles.filePanelGitPlaceholder}>
                <GitBranchIcon size={13} />
                <Text truncate>{git.summary?.status?.branch}</Text>
              </span>
            ) : git.hasRepository ? (
              <span className={styles.filePanelGitPlaceholder}>{t('workbench.gitLoading')}</span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className={styles.filePanelGitInitializeButton}
                disabled={initializingRepository}
                onClick={() => void handleInitializeRepository()}
              >
                {initializingRepository ? (
                  <SpinnerGapIcon size={13} className={styles.spinIcon} />
                ) : (
                  <GitBranchIcon size={13} />
                )}
                <Text truncate>{t('workbench.gitInitializeRepository')}</Text>
              </Button>
            )}
          </div>
        ) : (
          <div className={styles.panelTitleGroup} />
        )}
        <div className={styles.filePanelHeaderActions}>
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={t('workbench.searchFiles')}
            title={`${t('workbench.searchFiles')} · ${t('workbench.searchFilesHint')}`}
            data-active={isSearchVisible}
            onClick={toggleSearch}
          >
            <MagnifyingGlassIcon size={15} />
          </IconButton>
          {!!onCloseProject && (
            <IconButton
              variant="ghost"
              size="icon-sm"
              label={t('workbench.closeProject')}
              title={t('workbench.closeProject')}
              onClick={onCloseProject}
            >
              <XIcon size={15} />
            </IconButton>
          )}
        </div>
      </div>
      {isSearchVisible && (
        <div className={styles.searchBar}>
          <div className={styles.searchInputShell}>
            <MagnifyingGlassIcon size={13} />
            <Input
              size="sm"
              variant="ghost"
              value={searchQuery}
              autoFocus
              placeholder={t('workbench.projectSearchPlaceholder')}
              onChange={(event) => {
                setActiveSearchResultIndex(0)
                onSearchQueryChange(event.target.value)
              }}
              onKeyDown={handleSearchInputKeyDown}
            />
            {!!searchQuery && (
              <IconButton
                variant="ghost"
                size="icon-xs"
                className={styles.searchInputClearButton}
                label={t('workbench.clearSearch')}
                title={t('workbench.clearSearch')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={clearSearchInput}
              >
                <XIcon size={12} />
              </IconButton>
            )}
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
              selectedEntryPath={selectedEntryPath}
              onActivateSearchResult={setActiveSearchResultIndex}
              onContextMenuEntry={openContextMenu}
              onOpenContentSearchMatch={onOpenContentSearchMatch}
              onOpenSearchEntry={onOpenSearchEntry}
            />
          ) : (
            <>
              <FileTree
                entries={treeRootEntries}
                selectedPath={selectedEntryPath}
                expandedPaths={expandedPaths}
                childrenByPath={treeChildrenByPath}
                gitDecorations={gitDecorations}
                searchTerm={!searchActive && isSearchVisible ? normalizedSearchQuery : ''}
                isMutatingTree={isMutatingTree}
                onTreeApiChange={handleTreeApiChange}
                onSetDirectoryOpen={onSetDirectoryOpen}
                onSelectEntryPath={onSelectEntryPath}
                onSelectFile={onSelectFile}
                onContextMenuEntry={openContextMenu}
                onCreateEntry={onCreateEntry}
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
            {
              id: 'create-file',
              label: t('workbench.createFile'),
              icon: <FilePlusIcon size={14} />,
              disabled: isMutatingTree,
              onSelect: () => {
                const treeApi = treeApiRef.current
                void treeApi?.create({
                  type: 'leaf',
                  parentId:
                    contextMenu.entry.type === 'directory'
                      ? contextMenu.entry.path
                      : (treeApi?.get(contextMenu.entry.path)?.parent?.id ?? ROOT_PATH),
                })
              },
            },
            {
              id: 'create-directory',
              label: t('workbench.createDirectory'),
              icon: <FolderPlusIcon size={14} />,
              disabled: isMutatingTree,
              onSelect: () => {
                const treeApi = treeApiRef.current
                void treeApi?.create({
                  type: 'internal',
                  parentId:
                    contextMenu.entry.type === 'directory'
                      ? contextMenu.entry.path
                      : (treeApi?.get(contextMenu.entry.path)?.parent?.id ?? ROOT_PATH),
                })
              },
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
