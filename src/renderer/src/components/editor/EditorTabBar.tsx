import {
  type DragEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  CaretDownIcon,
  ChatCircleTextIcon,
  CodeIcon,
  DotsThreeVerticalIcon,
  EyeIcon,
  FileIcon,
  FloppyDiskIcon,
  GitDiffIcon,
  LockSimpleIcon,
  PencilSimpleIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useWorkbenchEditorTabOverflow } from '@renderer/hooks/useWorkbenchEditorTabOverflow'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchEditorEditMode } from '@renderer/models/editor/workbenchEditorEditMode'
import { isDirtyTab } from '@renderer/models/editor/workbenchEditorTabs'
import {
  getWorkbenchGitChangeDisplayPath,
  type WorkbenchGitChangeItem,
  type WorkbenchGitDecorationMap,
} from '@renderer/models/git/workbenchGitModel'
import type {
  WorkbenchLightEditorTab,
  WorkbenchOpenEditorTab,
} from '@renderer/types/workbenchTypes'

import { isPresent } from '@velaros-ai/core'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type { WorkbenchReadFileResult } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useBlockWheelScroll } from '../../support/useBlockWheelScroll'
import { useDismissOnWindowInteract } from '../../support/useDismissOnWindowInteract'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

interface WorkbenchEditorTabContextMenuState {
  path: string
  x: number
  y: number
}

/**
 * 辅助标签分组。`structure`（Velar 结构图）与 `ai-changes`（AI 改动对比）是**独占**组：组里有标签
 * 被激活时，标签栏只显示这一组，与普通文件标签隔开。
 */
export type WorkbenchEditorAuxiliaryTabGroup = 'primary' | 'structure' | 'ai-changes'

export const IsolatedWorkbenchEditorTabGroups: ReadonlySet<WorkbenchEditorAuxiliaryTabGroup> =
  new Set(['structure', 'ai-changes'])

export interface WorkbenchEditorAuxiliaryTabItem {
  id: string
  title: string
  label: ReactNode
  icon?: ReactNode
  active: boolean
  group?: WorkbenchEditorAuxiliaryTabGroup
  kind?: string
  onSelect: () => void
  onClose?: () => void
}

interface EditorTabBarProps {
  openTabs: WorkbenchOpenEditorTab[]
  selectedFilePath: Nullable<string>
  selectedFile: Nullable<WorkbenchReadFileResult>
  hasUnsavedChanges: boolean
  canEditSelectedFile: boolean
  /** 当前文件的只读 / 编辑模式；null 表示当前没有可切换的普通文件（差异、预览等标签）。 */
  selectedFileEditMode?: Nullable<WorkbenchEditorEditMode>
  onToggleSelectedFileEditMode?: () => void
  isSavingFile: boolean
  dirtyTabCount: number
  gitDecorations: WorkbenchGitDecorationMap
  diffTabItem?: LooseOptional<WorkbenchGitChangeItem>
  lightTabItem?: LooseOptional<WorkbenchLightEditorTab>
  auxiliaryTabItems?: WorkbenchEditorAuxiliaryTabItem[]
  tabContextMenu: Nullable<WorkbenchEditorTabContextMenuState>
  onOpenTabContextMenu: (path: string, event: MouseEvent) => void
  onRunTabContextAction: (action: () => void) => void
  onSelectOpenFile: (path: string) => void
  onCloseOpenFile: (path: string) => void
  onCloseOtherOpenFiles: (path: string) => void
  onCloseAllOpenFiles: () => void
  onCloseUnmodifiedOpenFiles: () => void
  /** 标签右键「添加到聊天」：把这个文件作为引用挂到聊天输入框（只挂路径）。 */
  onAddFileToChat?: (path: string) => void
  onReorderOpenTabs: (fromPath: string, toPath: string) => void
  onSelectDiffTab?: () => void
  onCloseDiffTab?: () => void
  onSelectLightTab?: () => void
  onCloseLightTab?: () => void
  onSaveAllOpenFiles: () => void
  markdownPreviewAvailable?: boolean
  markdownPreviewActive?: boolean
  onToggleMarkdownPreview?: () => void
  ariaLabel?: string
  showWorkspaceActions?: boolean
}

function fileNameFromPath(path: string): string {
  return path.split('/').findLast((value) => !!value) ?? path
}

export function EditorTabBar({
  openTabs,
  selectedFilePath,
  selectedFile,
  selectedFileEditMode = null,
  onToggleSelectedFileEditMode,
  isSavingFile,
  dirtyTabCount,
  gitDecorations,
  diffTabItem = null,
  lightTabItem = null,
  auxiliaryTabItems = [],
  tabContextMenu,
  onOpenTabContextMenu,
  onRunTabContextAction,
  onSelectOpenFile,
  onCloseOpenFile,
  onCloseOtherOpenFiles,
  onCloseAllOpenFiles,
  onCloseUnmodifiedOpenFiles,
  onAddFileToChat,
  onReorderOpenTabs,
  onSelectDiffTab,
  onCloseDiffTab,
  onSelectLightTab,
  onCloseLightTab,
  onSaveAllOpenFiles,
  markdownPreviewAvailable = false,
  markdownPreviewActive = false,
  onToggleMarkdownPreview,
  ariaLabel,
  showWorkspaceActions = true,
}: EditorTabBarProps): Nullable<ReactElement> {
  const { t } = useWorkbenchI18n()
  const [openMenu, setOpenMenu] = useState<Nullable<'tabs' | 'actions'>>(null)
  const [draggingTabPath, setDraggingTabPath] = useState<Nullable<string>>(null)
  const [dragOverTabPath, setDragOverTabPath] = useState<Nullable<string>>(null)
  const tabListButtonRef = useRef<HTMLButtonElement>(null)
  const actionsButtonRef = useRef<HTMLButtonElement>(null)
  const tabListMenuRef = useRef<HTMLDivElement>(null)
  const actionsMenuRef = useRef<HTMLDivElement>(null)
  const tabContextMenuRef = useRef<HTMLDivElement>(null)
  const hasActiveAuxiliaryTab = auxiliaryTabItems.some((tab) => tab.active)
  const tabOverflowKey = [
    openTabs
      .map(
        (tab) =>
          `${tab.path}:${isDirtyTab(tab)}:${tab.externalChange?.status ?? ''}`
      )
      .join('\u001f'),
    diffTabItem ? getWorkbenchGitChangeDisplayPath(diffTabItem) : '',
    lightTabItem?.id ?? '',
    auxiliaryTabItems.map((tab) => `${tab.id}:${tab.title}:${tab.active}`).join('\u001f'),
  ].join('\u001e')
  const activeAuxiliaryTab = auxiliaryTabItems.find((tab) => tab.active)
  const activeTabKey = activeAuxiliaryTab
    ? `auxiliary:${activeAuxiliaryTab.id}`
    : diffTabItem
      ? `diff:${getWorkbenchGitChangeDisplayPath(diffTabItem)}`
      : lightTabItem
        ? `light:${lightTabItem.id}`
        : selectedFilePath
  const { tabScrollerOverflow, tabScrollerRef } = useWorkbenchEditorTabOverflow(
    tabOverflowKey,
    activeTabKey
  )

  function getMenuStyle(kind: 'tabs' | 'actions'): { right: number; top: number } {
    const anchor = kind === 'tabs' ? tabListButtonRef.current : actionsButtonRef.current
    const rect = anchor?.getBoundingClientRect()
    if (!rect) return { right: 8, top: 40 }

    return {
      right: Math.max(8, window.innerWidth - rect.right),
      top: rect.bottom + 6,
    }
  }

  function runToolbarAction(action: () => void): void {
    setOpenMenu(null)
    action()
  }

  function handleTabDragStart(path: string, event: DragEvent<HTMLDivElement>): void {
    setDraggingTabPath(path)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', path)
  }

  function handleTabDragOver(path: string, event: DragEvent<HTMLDivElement>): void {
    if (!draggingTabPath) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (path !== dragOverTabPath) setDragOverTabPath(path)
  }

  function handleTabDrop(path: string, event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    if (draggingTabPath && draggingTabPath !== path) {
      onReorderOpenTabs(draggingTabPath, path)
    }
    setDraggingTabPath(null)
    setDragOverTabPath(null)
  }

  function handleTabDragEnd(): void {
    setDraggingTabPath(null)
    setDragOverTabPath(null)
  }

  const menuOpenKind = isPresent(openMenu)
  useBlockWheelScroll(tabContextMenuRef, isPresent(tabContextMenu))

  useEffect(() => {
    if (!tabScrollerOverflow && openMenu === 'tabs') {
      setOpenMenu(null)
    }
  }, [openMenu, tabScrollerOverflow])

  useDismissOnWindowInteract({
    enabled: menuOpenKind,
    onDismiss: () => setOpenMenu(null),
    ignoreMouseDown: (event: globalThis.MouseEvent): boolean => {
      const target = event.target as Nullable<Node>
      return !!(
        target &&
        (tabListButtonRef.current?.contains(target) ||
          actionsButtonRef.current?.contains(target) ||
          tabListMenuRef.current?.contains(target) ||
          actionsMenuRef.current?.contains(target))
      )
    },
  })

  if (!openTabs.length && !diffTabItem && !lightTabItem && !auxiliaryTabItems.length) return null

  const diffTabTitle = diffTabItem ? getWorkbenchGitChangeDisplayPath(diffTabItem) : ''
  const lightTabFileName = lightTabItem ? fileNameFromPath(lightTabItem.path) : ''

  return (
    <>
      <div
        className={styles.editorTabBar}
        role="tablist"
        aria-label={ariaLabel ?? t('workbench.openFiles')}
      >
        <div ref={tabScrollerRef} className={styles.editorTabScroller}>
          {openTabs.map((tab) => {
            const isDirty = isDirtyTab(tab)
            const isActive =
              !diffTabItem &&
              !lightTabItem &&
              !hasActiveAuxiliaryTab &&
              tab.path === selectedFilePath
            const gitDecoration = gitDecorations.get(tab.path)
            const hasExternalChange = !!tab.externalChange

            return (
              <div
                key={tab.path}
                className={styles.editorTab}
                data-active={isActive}
                data-dirty={isDirty}
                data-external-change={hasExternalChange}
                data-dragging={tab.path === draggingTabPath}
                data-drop-target={tab.path === dragOverTabPath && tab.path !== draggingTabPath}
                draggable
                onContextMenu={(event) => onOpenTabContextMenu(tab.path, event)}
                onDragStart={(event) => handleTabDragStart(tab.path, event)}
                onDragOver={(event) => handleTabDragOver(tab.path, event)}
                onDrop={(event) => handleTabDrop(tab.path, event)}
                onDragEnd={handleTabDragEnd}
              >
                <Button
                  variant="ghost"
                  size="block"
                  className={styles.editorTabMain}
                  role="tab"
                  aria-selected={isActive}
                  title={
                    hasExternalChange
                      ? `${tab.path} · ${t('workbench.externalFileChangedTitle')}`
                      : tab.path
                  }
                  onClick={() => onSelectOpenFile(tab.path)}
                >
                  <WorkbenchFileTypeIcon fileName={tab.path} size={13} />
                  <span className={styles.editorTabName} data-git-tone={gitDecoration?.tone}>
                    {fileNameFromPath(tab.path)}
                  </span>
                  {hasExternalChange && <WarningCircleIcon size={12} weight="fill" />}
                </Button>
                <IconButton
                  size="icon-sm"
                  className={styles.editorTabClose}
                  title={t('workbench.closeEditorTab')}
                  label={t('workbench.closeEditorTab')}
                  onClick={() => onCloseOpenFile(tab.path)}
                >
                  <XIcon size={12} />
                </IconButton>
              </div>
            )
          })}
          {!!diffTabItem && (
            <div className={styles.editorTab} data-active={!hasActiveAuxiliaryTab} data-kind="diff">
              <Button
                variant="ghost"
                size="block"
                className={styles.editorTabMain}
                role="tab"
                aria-selected={!hasActiveAuxiliaryTab}
                title={diffTabTitle}
                onClick={onSelectDiffTab}
              >
                <GitDiffIcon size={13} />
                <span className={styles.editorTabName}>
                  {t('workbench.gitDiffTabTitle', { file: diffTabItem.fileName })}
                </span>
              </Button>
              <IconButton
                size="icon-sm"
                className={styles.editorTabClose}
                title={t('workbench.closeEditorTab')}
                label={t('workbench.closeEditorTab')}
                onClick={onCloseDiffTab}
              >
                <XIcon size={12} />
              </IconButton>
            </div>
          )}
          {!!lightTabItem && (
            <div
              className={styles.editorTab}
              data-active={!hasActiveAuxiliaryTab}
              data-kind="light"
            >
              <Button
                variant="ghost"
                size="block"
                className={styles.editorTabMain}
                role="tab"
                aria-selected={!hasActiveAuxiliaryTab}
                title={`${lightTabItem.projectRoot}/${lightTabItem.path}`}
                onClick={onSelectLightTab}
              >
                <WorkbenchFileTypeIcon fileName={lightTabItem.path} size={13} />
                <span className={styles.editorTabName}>
                  {t('workbench.lightPreviewTabTitle', { file: lightTabFileName })}
                </span>
              </Button>
              <IconButton
                size="icon-sm"
                className={styles.editorTabClose}
                title={t('workbench.closeEditorTab')}
                label={t('workbench.closeEditorTab')}
                onClick={onCloseLightTab}
              >
                <XIcon size={12} />
              </IconButton>
            </div>
          )}
          {auxiliaryTabItems.map((tab) => (
            <div
              key={tab.id}
              className={styles.editorTab}
              data-active={tab.active}
              data-kind={tab.kind ?? 'auxiliary'}
            >
              <Button
                variant="ghost"
                size="block"
                className={styles.editorTabMain}
                role="tab"
                aria-selected={tab.active}
                title={tab.title}
                onClick={tab.onSelect}
              >
                {tab.icon}
                <span className={styles.editorTabName}>{tab.label}</span>
              </Button>
              {tab.onClose && (
                <IconButton
                  size="icon-sm"
                  className={styles.editorTabClose}
                  title={t('workbench.closeEditorTab')}
                  label={t('workbench.closeEditorTab')}
                  onClick={tab.onClose}
                >
                  <XIcon size={12} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
        <div className={styles.editorTabActions}>
          {!!selectedFileEditMode
            && !!onToggleSelectedFileEditMode
            && !selectedFile?.imagePreview
            && !selectedFile?.truncated
            && !selectedFile?.textIssue && (
            <IconButton
              size="icon-sm"
              className={styles.editorTabActionButton}
              title={
                selectedFileEditMode === 'read-only'
                  ? t('workbench.editorSwitchToEditMode')
                  : t('workbench.editorSwitchToReadOnlyMode')
              }
              label={
                selectedFileEditMode === 'read-only'
                  ? t('workbench.editorSwitchToEditMode')
                  : t('workbench.editorSwitchToReadOnlyMode')
              }
              aria-pressed={selectedFileEditMode === 'read-only'}
              data-edit-mode={selectedFileEditMode}
              onClick={onToggleSelectedFileEditMode}
            >
              {selectedFileEditMode === 'read-only' ? (
                <LockSimpleIcon size={15} />
              ) : (
                <PencilSimpleIcon size={15} />
              )}
            </IconButton>
          )}
          {markdownPreviewAvailable && (
            <IconButton
              size="icon-sm"
              className={styles.editorTabActionButton}
              title={
                markdownPreviewActive
                  ? t('workbench.markdownShowSource')
                  : t('workbench.markdownShowPreview')
              }
              label={
                markdownPreviewActive
                  ? t('workbench.markdownShowSource')
                  : t('workbench.markdownShowPreview')
              }
              aria-pressed={markdownPreviewActive}
              onClick={onToggleMarkdownPreview}
            >
              {markdownPreviewActive ? <CodeIcon size={15} /> : <EyeIcon size={15} />}
            </IconButton>
          )}
          {!!tabScrollerOverflow && (
            <IconButton
              ref={tabListButtonRef}
              size="icon-sm"
              className={styles.editorTabActionButton}
              title={t('workbench.showOpenEditorTabs')}
              label={t('workbench.showOpenEditorTabs')}
              aria-expanded={openMenu === 'tabs'}
              onClick={() => setOpenMenu((menu) => (menu === 'tabs' ? null : 'tabs'))}
            >
              <CaretDownIcon size={15} />
            </IconButton>
          )}
          {showWorkspaceActions && (
            <IconButton
              ref={actionsButtonRef}
              size="icon-sm"
              className={styles.editorTabActionButton}
              title={t('workbench.editorTabActions')}
              label={t('workbench.editorTabActions')}
              aria-expanded={openMenu === 'actions'}
              onClick={() => setOpenMenu((menu) => (menu === 'actions' ? null : 'actions'))}
            >
              <DotsThreeVerticalIcon size={16} />
            </IconButton>
          )}
        </div>
      </div>
      {openMenu === 'tabs' && (
        <div
          ref={tabListMenuRef}
          className={styles.editorTabListMenu}
          style={getMenuStyle('tabs')}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {openTabs.map((tab) => {
            const isActive =
              !diffTabItem &&
              !lightTabItem &&
              !hasActiveAuxiliaryTab &&
              tab.path === selectedFilePath
            const gitDecoration = gitDecorations.get(tab.path)
            const hasExternalChange = !!tab.externalChange

            return (
              <div
                key={tab.path}
                className={styles.editorTabListItem}
                data-active={isActive}
                data-external-change={hasExternalChange}
              >
                <Button
                  variant="ghost"
                  size="block"
                  className={styles.editorTabListMain}
                  title={tab.path}
                  onClick={() => runToolbarAction(() => onSelectOpenFile(tab.path))}
                >
                  <WorkbenchFileTypeIcon fileName={tab.path} size={14} />
                  <span className={styles.editorTabName} data-git-tone={gitDecoration?.tone}>
                    {fileNameFromPath(tab.path)}
                  </span>
                  {hasExternalChange && <WarningCircleIcon size={12} weight="fill" />}
                </Button>
                <IconButton
                  size="icon-sm"
                  className={styles.editorTabListClose}
                  title={t('workbench.closeEditorTab')}
                  label={t('workbench.closeEditorTab')}
                  onClick={() => runToolbarAction(() => onCloseOpenFile(tab.path))}
                >
                  <XIcon size={13} />
                </IconButton>
              </div>
            )
          })}
          {!!diffTabItem && (
            <div className={styles.editorTabListItem} data-active={!hasActiveAuxiliaryTab}>
              <Button
                variant="ghost"
                size="block"
                className={styles.editorTabListMain}
                title={diffTabItem.path}
                onClick={() => runToolbarAction(() => onSelectDiffTab?.())}
              >
                <GitDiffIcon size={14} />
                <span className={styles.editorTabName}>
                  {t('workbench.gitDiffTabTitle', { file: diffTabItem.fileName })}
                </span>
              </Button>
              <IconButton
                size="icon-sm"
                className={styles.editorTabListClose}
                title={t('workbench.closeEditorTab')}
                label={t('workbench.closeEditorTab')}
                onClick={() => runToolbarAction(() => onCloseDiffTab?.())}
              >
                <XIcon size={13} />
              </IconButton>
            </div>
          )}
          {!!lightTabItem && (
            <div className={styles.editorTabListItem} data-active={!hasActiveAuxiliaryTab}>
              <Button
                variant="ghost"
                size="block"
                className={styles.editorTabListMain}
                title={`${lightTabItem.projectRoot}/${lightTabItem.path}`}
                onClick={() => runToolbarAction(() => onSelectLightTab?.())}
              >
                <WorkbenchFileTypeIcon fileName={lightTabItem.path} size={14} />
                <span className={styles.editorTabName}>
                  {t('workbench.lightPreviewTabTitle', { file: lightTabFileName })}
                </span>
              </Button>
              <IconButton
                size="icon-sm"
                className={styles.editorTabListClose}
                title={t('workbench.closeEditorTab')}
                label={t('workbench.closeEditorTab')}
                onClick={() => runToolbarAction(() => onCloseLightTab?.())}
              >
                <XIcon size={13} />
              </IconButton>
            </div>
          )}
          {auxiliaryTabItems.map((tab) => (
            <div key={tab.id} className={styles.editorTabListItem} data-active={tab.active}>
              <Button
                variant="ghost"
                size="block"
                className={styles.editorTabListMain}
                title={tab.title}
                onClick={() => runToolbarAction(tab.onSelect)}
              >
                {tab.icon}
                <span className={styles.editorTabName}>{tab.label}</span>
              </Button>
              {tab.onClose && (
                <IconButton
                  size="icon-sm"
                  className={styles.editorTabListClose}
                  title={t('workbench.closeEditorTab')}
                  label={t('workbench.closeEditorTab')}
                  onClick={() => runToolbarAction(() => tab.onClose?.())}
                >
                  <XIcon size={13} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}
      {openMenu === 'actions' && (
        <div
          ref={actionsMenuRef}
          className={styles.editorTabContextMenu}
          style={getMenuStyle('actions')}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="block"
            onClick={() => runToolbarAction(onCloseUnmodifiedOpenFiles)}
          >
            <XIcon size={14} />
            <Text truncate>{t('workbench.closeUnmodifiedEditorTabs')}</Text>
          </Button>
          <Button
            variant="ghost"
            size="block"
            onClick={() => runToolbarAction(onCloseAllOpenFiles)}
          >
            <XIcon size={14} />
            <Text truncate>{t('workbench.closeAllEditorTabs')}</Text>
          </Button>
        </div>
      )}
      {!!tabContextMenu && (
        <div
          ref={tabContextMenuRef}
          className={styles.editorTabContextMenu}
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="block"
            onClick={() => onRunTabContextAction(() => onSelectOpenFile(tabContextMenu.path))}
          >
            <FileIcon size={14} />
            <Text truncate>{t('workbench.openTab')}</Text>
          </Button>
          {!!onAddFileToChat && (
            <Button
              variant="ghost"
              size="block"
              onClick={() => onRunTabContextAction(() => onAddFileToChat(tabContextMenu.path))}
            >
              <ChatCircleTextIcon size={14} />
              <Text truncate>{t('workbench.editorContextAddToChat')}</Text>
            </Button>
          )}
          <Button
            variant="ghost"
            size="block"
            disabled={isSavingFile || !dirtyTabCount}
            onClick={() => onRunTabContextAction(onSaveAllOpenFiles)}
          >
            <FloppyDiskIcon size={14} />
            <Text truncate>{t('workbench.saveAllFiles')}</Text>
          </Button>
          <Button
            variant="ghost"
            size="block"
            onClick={() => onRunTabContextAction(() => onCloseOtherOpenFiles(tabContextMenu.path))}
          >
            <XIcon size={14} />
            <Text truncate>{t('workbench.closeOtherEditorTabs')}</Text>
          </Button>
          <Button
            variant="ghost"
            size="block"
            onClick={() => onRunTabContextAction(onCloseAllOpenFiles)}
          >
            <XIcon size={14} />
            <Text truncate>{t('workbench.closeAllEditorTabs')}</Text>
          </Button>
        </div>
      )}
    </>
  )
}
