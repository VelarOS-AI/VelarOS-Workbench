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
  ClipboardTextIcon,
  CopyIcon,
  CopySimpleIcon,
  FilePlusIcon,
  FilesIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HammerIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlayIcon,
  ScissorsIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useWorkbenchDensity } from '@renderer/hooks/useWorkbenchPreferences'
import type { WorkbenchProjectSearchModel } from '@renderer/hooks/useWorkbenchProjectSearchController'
import { useWorkbenchI18n } from '@renderer/i18n'
import { isWorkbenchVelarFilePath } from '@renderer/models/commands/workbenchVelarFileCommand'
import { getWorkbenchFileSearchKeyboardAction } from '@renderer/models/files/workbenchFileSearchNavigationModel'
import {
  buildWorkbenchProjectSearchRows,
  isOpenableWorkbenchProjectSearchRow,
  type WorkbenchProjectSearchRow,
} from '@renderer/models/files/workbenchProjectSearchModel'
import {
  getWorkbenchFileTreeShortcutAction,
  selectTopLevelTreeEntries,
} from '@renderer/models/files/workbenchTreeMutation'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import { getWorkbenchFileTreeRowHeight } from '@renderer/models/settings/workbenchPreferences'
import { ROOT_PATH } from '@renderer/models/shared/workbenchUtils'

import { currentPlatform as systemPlatformCompatibility } from '@velaros-ai/core/platform'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { WorkbenchDirectoryEntry, WorkbenchSearchEntriesResult } from '@shared/contracts'
import { isWorkbenchSearchPathIncluded } from '@shared/workbenchSearchGlob'

import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'
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
import { ProjectSearchForm, ProjectSearchSummary } from './ProjectSearchForm'

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
  /** 输入框里的查找词：按文件名找（searchResult）与项目内容搜索共用。 */
  searchQuery: string
  searchResult: Nullable<WorkbenchSearchEntriesResult>
  /** 查找词不是空白：结果盖住文件树。 */
  searchActive: boolean
  /** 项目内容搜索与替换：开关、替换、结果都在它这里。 */
  projectSearch: WorkbenchProjectSearchModel
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
  onRefreshProject: () => void
  onCloseProject?: () => void
  onOpenSearchEntry: (entry: WorkbenchDirectoryEntry) => void
  onSetDirectoryOpen: (path: string, open: boolean) => void
  onSelectFile: (path: string) => void
  onRunFile?: (path: string) => void
  onBuildFile?: (path: string) => void
  /** 右键「添加到聊天」：把文件作为引用挂到聊天输入框（只挂路径，一次可以挂一组多选的文件）。 */
  onAddFilesToChat?: (paths: readonly string[]) => void
  /** 复制（粘贴、创建副本）到 `parentEntry` 里，null 是项目根。 */
  onCopyEntries?: (
    entries: WorkbenchDirectoryEntry[],
    parentEntry: Nullable<WorkbenchDirectoryEntry>
  ) => Promise<void>
  /** 在访达（资源管理器）里显示这个绝对路径。 */
  onRevealEntry?: (absolutePath: string) => void
}

/** 文件树的剪贴板：复制或剪切了哪些项，粘贴时复制或移动过去。只在工作台里用，不碰系统剪贴板。 */
interface FileTreeClipboard {
  mode: 'copy' | 'cut'
  entries: WorkbenchDirectoryEntry[]
}

const isApplePlatform = /Mac|iPhone|iPad/u.test(navigator.platform)
const PrimaryKeyLabel = isApplePlatform ? '⌘' : 'Ctrl+'
const RevealInSystemLabelKey = isApplePlatform
  ? 'workbench.revealInFinder'
  : navigator.platform.startsWith('Win')
    ? 'workbench.revealInExplorer'
    : 'workbench.openContainingFolder'

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
  search: { searchQuery, searchResult, searchActive, projectSearch },
  handlers: {
    onSelectEntryPath,
    onCreateEntry,
    onRenameEntry,
    onDeleteEntries,
    onUndoDeleteEntries,
    onMoveEntries,
    onSearchQueryChange,
    onRefreshProject,
    onOpenSearchEntry,
    onSetDirectoryOpen,
    onSelectFile,
    onRunFile,
    onBuildFile,
    onAddFilesToChat,
    onCopyEntries,
    onRevealEntry,
  },
}: FilePanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const filePanelRef = useRef<HTMLElement>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const treeApiRef = useRef<FileTreeApi>(null)
  const [contextMenu, setContextMenu] = useState<
    LooseOptional<{
      x: number
      y: number
      entry: WorkbenchDirectoryEntry
      /** 「添加到聊天」要挂的文件：右键时就定下来，点在多选里是整组里的文件。 */
      chatFilePaths: string[]
    }>
  >(null)
  const [activeSearchRowKey, setActiveSearchRowKey] = useState<Nullable<string>>(null)
  const [treeClipboard, setTreeClipboard] = useState<Nullable<FileTreeClipboard>>(null)
  const searchRowHeight = getWorkbenchFileTreeRowHeight(useWorkbenchDensity())
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
  // 按文件名找到的条目也按「包含 / 排除的文件」筛。
  const searchEntries = useMemo(
    () =>
      (searchResult?.entries ?? []).filter((entry) =>
        isWorkbenchSearchPathIncluded(projectSearch.pathFilter, entry.path)
      ),
    [projectSearch.pathFilter, searchResult]
  )
  const searchRows = useMemo(
    () =>
      buildWorkbenchProjectSearchRows({
        entries: searchEntries,
        entriesCollapsed: projectSearch.entriesCollapsed,
        files: projectSearch.files,
        collapsedPaths: projectSearch.collapsedPaths,
      }),
    [projectSearch.collapsedPaths, projectSearch.entriesCollapsed, projectSearch.files, searchEntries]
  )
  const openableSearchRows = useMemo(
    () => searchRows.filter(isOpenableWorkbenchProjectSearchRow),
    [searchRows]
  )
  // 挑中的行不在了（新的结果、收起了文件）就回到第一行。
  const activeSearchRow =
    openableSearchRows.find((row) => row.key === activeSearchRowKey) ?? openableSearchRows[0]

  // 换了一份搜索结果：列表回到顶上，挑中的行回到第一行。
  useEffect(() => {
    if (treeScrollRef.current) treeScrollRef.current.scrollTop = 0
    setActiveSearchRowKey(null)
  }, [projectSearch.resultsGeneration])

  /**
   * 右键或快捷键作用的一组项：右键点在多选里（或用快捷键）是整组，否则是右键的那一项；不含项目根，已经在选中的
   * 目录里面的子项去掉（复制目录本来就带着它们）。
   */
  const resolveActionEntries = (entry?: WorkbenchDirectoryEntry): WorkbenchDirectoryEntry[] => {
    const tree = treeApiRef.current
    const entries =
      entry && !isTreeEntryInMultiSelection(tree, entry.path)
        ? [entry]
        : (tree?.selectedNodes.map((node) => node.data.entry) ?? [])
    return selectTopLevelTreeEntries(entries.filter((candidate) => candidate.path !== ROOT_PATH))
  }
  const parentDirectoryOf = (entry: WorkbenchDirectoryEntry): WorkbenchDirectoryEntry => {
    const cut = entry.path.lastIndexOf('/')
    if (cut < 0) return rootTreeEntry
    const path = entry.path.slice(0, cut)
    return (
      treeApiRef.current?.get(path)?.data.entry ?? {
        ...rootTreeEntry,
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
      }
    )
  }
  /** 粘贴到哪：目录就是它自己，文件是它所在的目录，什么都没选时是项目根。 */
  const pasteTargetOf = (entry: Nullable<WorkbenchDirectoryEntry>): WorkbenchDirectoryEntry =>
    !entry ? rootTreeEntry : entry.type === 'directory' ? entry : parentDirectoryOf(entry)
  const toParentArgument = (target: WorkbenchDirectoryEntry): Nullable<WorkbenchDirectoryEntry> =>
    target.path === ROOT_PATH ? null : target

  const clipEntries = (mode: FileTreeClipboard['mode'], entries: WorkbenchDirectoryEntry[]): void => {
    if (entries.length > 0) setTreeClipboard({ mode, entries })
  }
  const pasteInto = async (target: WorkbenchDirectoryEntry): Promise<void> => {
    if (!treeClipboard) return
    if (treeClipboard.mode === 'cut') {
      setTreeClipboard(null)
      await onMoveEntries(treeClipboard.entries, toParentArgument(target), 0)
    } else {
      await onCopyEntries?.(treeClipboard.entries, toParentArgument(target))
    }
  }
  /** 每一项复制一份放在它自己所在的目录里（重名时主进程取「名字 copy」）。 */
  const duplicateEntries = async (entries: WorkbenchDirectoryEntry[]): Promise<void> => {
    for (const entry of entries)
      await onCopyEntries?.([entry], toParentArgument(parentDirectoryOf(entry)))
  }
  const treeClipboardActionsLatest = useLatest({
    copy: () => clipEntries('copy', resolveActionEntries()),
    cut: () => clipEntries('cut', resolveActionEntries()),
    paste: () => pasteInto(pasteTargetOf(treeApiRef.current?.mostRecentNode?.data.entry ?? null)),
    duplicate: () => duplicateEntries(resolveActionEntries()),
  })

  const handleTreeApiChange = useCallback((api: Nullable<FileTreeApi>): void => {
    treeApiRef.current = api || null
  }, [])

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

      const treePanel = treeScrollRef.current
      const treeTargetInside = !!(targetNode && treePanel?.contains(targetNode))
      const treeFocusInside = !!(activeElement && treePanel?.contains(activeElement))
      const inTree = !searchActive && (treeTargetInside || treeFocusInside)
      const clipboardActions = treeClipboardActionsLatest.current
      if (action === 'delete-selected') {
        if (inTree) deleteSelectedTreeEntries(treeApiRef.current)
      } else if (action === 'undo-delete') {
        void onUndoDeleteEntries()
      } else if (inTree) {
        if (action === 'copy-selected') clipboardActions.copy()
        else if (action === 'cut-selected') clipboardActions.cut()
        else if (action === 'paste') void clipboardActions.paste()
        else void clipboardActions.duplicate()
      }
    }

    window.addEventListener('keydown', handleFilePanelKeyDown, true)
    return () => window.removeEventListener('keydown', handleFilePanelKeyDown, true)
  }, [onUndoDeleteEntries, searchActive, treeClipboardActionsLatest])

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
    // 文件树与搜索结果里的行各有各的菜单（或者没有），不弹工程根目录的菜单。
    if (
      event.target instanceof HTMLElement
      && event.target.closest('button, [data-tree-path], [data-search-row]')
    )
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
    setActiveSearchRowKey(null)
    projectSearch.togglePanel()
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

  /** 结果只渲染视野里的行：键盘挑中的行在视野外时把滚动条挪过去。 */
  function scrollSearchRowIntoView(key: string): void {
    const scroll = treeScrollRef.current
    const index = searchRows.findIndex((row) => row.key === key)
    if (!scroll || index === -1) return

    const top = index * searchRowHeight
    if (top < scroll.scrollTop) scroll.scrollTop = top
    else if (top + searchRowHeight > scroll.scrollTop + scroll.clientHeight)
      scroll.scrollTop = top + searchRowHeight - scroll.clientHeight
  }

  function openSearchRow(row: WorkbenchProjectSearchRow): void {
    if (row.kind === 'entry') onOpenSearchEntry(row.entry)
    else if (row.kind === 'match') projectSearch.openMatch(row.file, row.match)
  }

  /** 查找框里的上下键在结果里挑行，回车打开挑中的那一行；用掉了按键返回 true。 */
  function handleSearchNavigationKey(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
    const activeIndex = activeSearchRow ? openableSearchRows.indexOf(activeSearchRow) : 0
    const action = getWorkbenchFileSearchKeyboardAction(event.key, activeIndex, openableSearchRows.length)
    if (!action) return false

    if (action.kind === 'set-active') {
      const row = openableSearchRows[action.index]
      if (row) {
        setActiveSearchRowKey(row.key)
        scrollSearchRowIntoView(row.key)
      }
      return true
    }

    if (activeSearchRow) openSearchRow(activeSearchRow)
    return true
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
          data-active={projectSearch.isOpen || undefined}
          onClick={toggleSearch}
        >
          <MagnifyingGlassIcon size={14} />
        </IconButton>
      </div>
      {projectSearch.isOpen && (
        <ProjectSearchForm
          query={searchQuery}
          search={projectSearch}
          onQueryChange={(query) => {
            setActiveSearchRowKey(null)
            onSearchQueryChange(query)
          }}
          onQueryNavigationKey={handleSearchNavigationKey}
        />
      )}
      {searchActive && <ProjectSearchSummary search={projectSearch} />}
      <div className={styles.filePanelBody}>
        <ScrollArea
          ref={treeScrollRef}
          className={styles.treeScroll}
          aria-label={t('workbench.files')}
          onContextMenu={openRootContextMenu}
        >
          {searchActive ? (
            <FileSearchResults
              rows={searchRows}
              rowHeight={searchRowHeight}
              scrollRef={treeScrollRef}
              activeRowKey={activeSearchRow?.key ?? null}
              gitDecorations={gitDecorations}
              selectedEntryPath={selectedEntryPath}
              previewReplacement={projectSearch.replaceOpen ? projectSearch.previewReplacement : null}
              replaceDisabled={!projectSearch.canReplace}
              onActivateRow={setActiveSearchRowKey}
              onToggleEntries={projectSearch.toggleEntriesCollapsed}
              onToggleFile={projectSearch.toggleFileCollapsed}
              onOpenEntry={onOpenSearchEntry}
              onOpenMatch={projectSearch.openMatch}
              onReplaceFile={projectSearch.replaceFile}
              onReplaceMatch={projectSearch.replaceMatch}
              onContextMenuEntry={openContextMenu}
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
            ...(onRevealEntry
              ? [
                  {
                    id: 'reveal-in-system',
                    label: t(RevealInSystemLabelKey),
                    icon: <FolderOpenIcon size={14} />,
                    onSelect: () =>
                      onRevealEntry(
                        resolveWorkbenchEntryAbsolutePath(project.rootPath, contextMenu.entry.path)
                      ),
                  },
                ]
              : []),
            {
              id: 'search-project',
              label: t('workbench.searchFiles'),
              icon: <MagnifyingGlassIcon size={14} />,
              separatorBefore: true,
              onSelect: () => {
                setActiveSearchRowKey(null)
                projectSearch.openPanel()
              },
            },
            {
              id: 'refresh-project',
              label: t('workbench.refreshFiles'),
              icon: <ArrowClockwiseIcon size={14} />,
              disabled: isLoadingTree || isMutatingTree,
              onSelect: onRefreshProject,
            },
            ...(onCopyEntries
              ? [
                  {
                    id: 'cut-entry',
                    label: t('workbench.cutEntry'),
                    icon: <ScissorsIcon size={14} />,
                    shortcut: `${PrimaryKeyLabel}X`,
                    separatorBefore: true,
                    disabled: isMutatingTree || contextMenu.entry.path === ROOT_PATH,
                    onSelect: () => clipEntries('cut', resolveActionEntries(contextMenu.entry)),
                  },
                  {
                    id: 'copy-entry',
                    label: t('workbench.copyEntry'),
                    icon: <CopySimpleIcon size={14} />,
                    shortcut: `${PrimaryKeyLabel}C`,
                    disabled: contextMenu.entry.path === ROOT_PATH,
                    onSelect: () => clipEntries('copy', resolveActionEntries(contextMenu.entry)),
                  },
                  {
                    id: 'paste-entry',
                    label: t('workbench.pasteEntry'),
                    icon: <ClipboardTextIcon size={14} />,
                    shortcut: `${PrimaryKeyLabel}V`,
                    disabled: isMutatingTree || !treeClipboard,
                    onSelect: () => pasteInto(pasteTargetOf(contextMenu.entry)),
                  },
                  {
                    id: 'duplicate-entry',
                    label: t('workbench.duplicateEntry'),
                    icon: <FilesIcon size={14} />,
                    shortcut: `${PrimaryKeyLabel}D`,
                    disabled: isMutatingTree || contextMenu.entry.path === ROOT_PATH,
                    onSelect: () => duplicateEntries(resolveActionEntries(contextMenu.entry)),
                  },
                ]
              : []),
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
