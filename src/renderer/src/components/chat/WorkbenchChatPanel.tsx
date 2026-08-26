import {
  type HTMLAttributes,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ArchiveIcon, ChatCircleTextIcon, PlusIcon, SpinnerGapIcon } from '@phosphor-icons/react'

import { isEmpty, toNullable } from '@velaros-ai/core'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'
import {
  BusinessCascadingMenu,
  type BusinessCascadingMenuRenderProps,
  BusinessCascadingMenuSelectedIndicator,
} from '@velaros-ai/ui/product/menus/BusinessCascadingMenu'

import type { WorkbenchChatProviderId } from '../../../../plugins/agent-engines/identity'
import {
  useWorkbenchChatProjectRuntime,
  useWorkbenchProductRuntime,
  type WorkbenchBrowserElementSelectionDelivery,
  type WorkbenchChatFileChangeEntry,
  type WorkbenchChatSessionGroup,
  type WorkbenchChatSessionMember,
  WorkbenchChatSessionSurface,
} from '../../composition'
import { useWorkbenchI18n } from '../../i18n'
import {
  getMostRecentlyUpdatedWorkbenchProjectChatGroup,
  isWorkbenchProjectChatGroup,
} from '../../models/chat/workbenchChatSessionGroups'

type WorkbenchChatFolderGroup = WorkbenchChatSessionGroup
type WorkbenchChatFolderMember = WorkbenchChatSessionMember

const EmptyWorkbenchBrowserElementSelections: readonly WorkbenchBrowserElementSelectionDelivery[] =
  []

export interface WorkbenchChatPanelProps {
  providerId?: WorkbenchChatProviderId
  projectRoot: string
  currentFilePath: Nullable<string>
  pendingBrowserElementSelections?: readonly WorkbenchBrowserElementSelectionDelivery[]
  onBrowserElementSelectionsConsumed?: (deliveryIds: readonly string[]) => void
  onOpenFileChange?: (entry: WorkbenchChatFileChangeEntry) => void | Promise<void>
  onOpenWorkspacePath?: (path: string) => unknown
  onReviewFileChanges?: (entries: readonly WorkbenchChatFileChangeEntry[]) => void | Promise<void>
  onArchiveError?: (error: unknown) => void
}

interface WorkbenchChatSessionMenuProps {
  activeMemberSessionId: string
  currentTitle: string
  disabled: boolean
  fallbackTitle: string
  members: WorkbenchChatFolderMember[]
  open: boolean
  title: string
  onOpenChange: (open: boolean) => void
  onSelectMember: (member: WorkbenchChatFolderMember) => void
}

function normalizeWorkbenchProjectRoot(projectRoot: string): string {
  return projectRoot.trim()
}

function isWorkbenchChatSessionGroup(
  group: WorkbenchChatFolderGroup,
  projectRoot: string
): boolean {
  return isWorkbenchProjectChatGroup(group, projectRoot)
}

function getWorkbenchChatProjectMembers(
  group: Nullable<WorkbenchChatFolderGroup>,
  projectRoot: string
): WorkbenchChatFolderMember[] {
  if (!group) return []

  return group.members.filter((member) => member.workspaceRoot?.trim() === projectRoot)
}

function getWorkbenchChatActiveMember(
  group: WorkbenchChatFolderGroup
): WorkbenchChatFolderMember | undefined {
  return (
    group.members.find((member) => member.itemId === group.activeMemberItemId) ?? group.members[0]
  )
}

function getWorkbenchChatActiveProjectMember(
  group: Nullable<WorkbenchChatFolderGroup>,
  projectRoot: string
): WorkbenchChatFolderMember | undefined {
  if (!group) return undefined

  const activeMember = getWorkbenchChatActiveMember(group)
  if (activeMember?.workspaceRoot?.trim() === projectRoot) return activeMember

  return getWorkbenchChatProjectMembers(group, projectRoot)[0]
}

function resolveWorkbenchChatSessionLabel(
  member: WorkbenchChatFolderMember,
  fallbackTitle: string
): string {
  return member.title.trim() || member.workspaceTitle.trim() || fallbackTitle
}

function isWorkbenchChatSessionMemberUnstarted(member: WorkbenchChatFolderMember): boolean {
  return member.isEmpty
}

function WorkbenchChatSessionMenu({
  activeMemberSessionId,
  currentTitle,
  disabled,
  fallbackTitle,
  members,
  open,
  title,
  onOpenChange,
  onSelectMember,
}: WorkbenchChatSessionMenuProps): ReactElement {
  const styles = useWorkbenchProductRuntime().ui.chatPanel
  const renderItems = (menu: BusinessCascadingMenuRenderProps): ReactElement => {
    const primaryPanelProps = menu.getPrimaryPanelProps({
      role: 'menu',
      className: styles.workbenchChatSessionMenuList,
    }) as unknown as HTMLAttributes<HTMLDivElement>

    return (
      <div {...primaryPanelProps}>
        {isEmpty(members) ? (
          <Button
            variant="ghost"
            size="block"
            className={styles.workbenchChatSessionMenuItem}
            disabled
          >
            <span className={styles.workbenchChatSessionMenuText}>
              <span className={styles.workbenchChatSessionMenuTitle}>{fallbackTitle}</span>
            </span>
          </Button>
        ) : (
          members.map((member) => {
            const active = member.memberSessionId === activeMemberSessionId

            return (
              <Button
                key={member.memberSessionId}
                variant="ghost"
                size="block"
                {...menu.getLeafItemProps<HTMLButtonElement>({
                  className: styles.workbenchChatSessionMenuItem,
                  role: 'menuitem',
                })}
                data-active={active}
                onClick={() => {
                  menu.close()
                  onSelectMember(member)
                }}
              >
                <span className={styles.workbenchChatSessionMenuText}>
                  <span className={styles.workbenchChatSessionMenuTitle}>
                    {resolveWorkbenchChatSessionLabel(member, fallbackTitle)}
                  </span>
                </span>
                {active && (
                  <BusinessCascadingMenuSelectedIndicator
                    menu={menu}
                    className={styles.workbenchChatSessionMenuCheck}
                    size={12}
                  />
                )}
              </Button>
            )
          })
        )}
      </div>
    )
  }

  return (
    <BusinessCascadingMenu
      open={open}
      onOpenChange={onOpenChange}
      activeSubmenuId={null}
      onActiveSubmenuChange={() => undefined}
      onCloseSubmenus={() => undefined}
      anchorClassName={styles.workbenchChatSessionMenuAnchor}
      className={styles.workbenchChatSessionMenuPanel}
      side="bottom"
      align="start"
      sideOffset={8}
      widthStrategy="content"
      anchor={({ getAnchorProps }) => (
        <Button
          {...getAnchorProps<HTMLButtonElement>({
            disabled,
          })}
          variant="ghost"
          size="sm"
          hoverBackground={false}
          className={styles.workbenchChatSessionMenuButton}
          title={title}
          aria-label={title}
          data-open={open}
          disabled={disabled}
        >
          <ChatCircleTextIcon
            className={styles.workbenchChatSessionMenuIcon}
            size={16}
            weight="duotone"
          />
          <span className={styles.workbenchChatSessionCurrentTitle}>{currentTitle}</span>
        </Button>
      )}
    >
      {renderItems}
    </BusinessCascadingMenu>
  )
}

export function WorkbenchChatPanel({
  providerId = 'workbench',
  projectRoot,
  currentFilePath,
  pendingBrowserElementSelections = EmptyWorkbenchBrowserElementSelections,
  onBrowserElementSelectionsConsumed,
  onOpenFileChange,
  onOpenWorkspacePath,
  onReviewFileChanges,
  onArchiveError,
}: WorkbenchChatPanelProps): ReactElement {
  const styles = useWorkbenchProductRuntime().ui.chatPanel
  const normalizedProjectRoot = normalizeWorkbenchProjectRoot(projectRoot)
  const { t } = useWorkbenchI18n()
  const chat = useWorkbenchChatProjectRuntime(normalizedProjectRoot, providerId)
  const { currentSession, conversationVersion } = chat
  const { activeMemberSessionId, activeSessionId, deletingSessionId, diskSessionHydrated, groups } =
    chat.sessionList
  const { addProjectSession, archiveSession, selectSession, startProjectChat } = chat.actions
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const pendingStartFolderIdRef = useRef<Nullable<string>>(null)
  const restoredProjectRootRef = useRef<Nullable<string>>(null)
  const [pendingStartFolderId, setPendingStartFolderId] = useState<Nullable<string>>(null)

  const workbenchChatSessionGroups = useMemo(
    () => groups.filter((group) => isWorkbenchChatSessionGroup(group, normalizedProjectRoot)),
    [groups, normalizedProjectRoot]
  )
  const workbenchProjectFolderGroup = useMemo(
    () => getMostRecentlyUpdatedWorkbenchProjectChatGroup(workbenchChatSessionGroups),
    [workbenchChatSessionGroups]
  )
  const workbenchProjectChatMembers = useMemo(
    () =>
      getWorkbenchChatProjectMembers(
        toNullable(workbenchProjectFolderGroup),
        normalizedProjectRoot
      ),
    [normalizedProjectRoot, workbenchProjectFolderGroup]
  )
  const activeGroup = workbenchProjectFolderGroup
  const activeProjectMember = getWorkbenchChatActiveProjectMember(
    toNullable(activeGroup),
    normalizedProjectRoot
  )
  const activeGroupLabel = activeProjectMember
    ? resolveWorkbenchChatSessionLabel(activeProjectMember, t('sidebar.newChat'))
    : t('sidebar.newChat')
  const activeGroupId = activeGroup?.folderId ?? ''
  const unstartedWorkbenchChatSessionMember = workbenchProjectChatMembers.find(
    isWorkbenchChatSessionMemberUnstarted
  )
  const isActiveWorkbenchChatSessionUnstarted = !!activeProjectMember && activeProjectMember.isEmpty
  const isActiveGroupStreaming = workbenchProjectChatMembers.some((member) => member.isStreaming)
  const isDeletingActiveGroup = !!activeGroup && deletingSessionId === activeGroup.folderId
  const isDeleteDisabled = !activeGroup || isActiveGroupStreaming || !!deletingSessionId
  const isStartNewChatDisabled =
    !normalizedProjectRoot || !!pendingStartFolderId || isActiveWorkbenchChatSessionUnstarted
  const ready =
    !!activeGroup &&
    activeGroup.folderId === activeSessionId &&
    currentSession.kind === 'chat' &&
    currentSession.folderId === activeGroup.folderId &&
    currentSession.rootPath?.trim() === normalizedProjectRoot

  const selectWorkbenchChatSessionMember = useCallback(
    (member: WorkbenchChatFolderMember): void => {
      if (!workbenchProjectFolderGroup) return

      selectSession(workbenchProjectFolderGroup.folderId, member.memberSessionId)
    },
    [selectSession, workbenchProjectFolderGroup]
  )

  const startWorkbenchChatSession = useCallback(async (): Promise<Nullable<string>> => {
    if (!normalizedProjectRoot) return null
    if (pendingStartFolderIdRef.current) return null

    if (workbenchProjectFolderGroup) {
      if (unstartedWorkbenchChatSessionMember) {
        selectWorkbenchChatSessionMember(unstartedWorkbenchChatSessionMember)
        return workbenchProjectFolderGroup.folderId
      }

      pendingStartFolderIdRef.current = workbenchProjectFolderGroup.folderId
      setPendingStartFolderId(workbenchProjectFolderGroup.folderId)
      try {
        const added = await addProjectSession(
          workbenchProjectFolderGroup.folderId,
          normalizedProjectRoot
        )
        return added ? workbenchProjectFolderGroup.folderId : null
      } finally {
        pendingStartFolderIdRef.current = null
        setPendingStartFolderId(null)
      }
    }

    const createdFolderId = startProjectChat(normalizedProjectRoot)
    pendingStartFolderIdRef.current = createdFolderId
    setPendingStartFolderId(createdFolderId)
    return createdFolderId
  }, [
    addProjectSession,
    normalizedProjectRoot,
    selectWorkbenchChatSessionMember,
    startProjectChat,
    unstartedWorkbenchChatSessionMember,
    workbenchProjectFolderGroup,
  ])

  useEffect(() => {
    if (pendingStartFolderIdRef.current === activeGroupId) {
      pendingStartFolderIdRef.current = null
      setPendingStartFolderId(null)
    }
  }, [activeGroupId])

  useEffect(() => {
    if (!normalizedProjectRoot || !diskSessionHydrated) return
    if (restoredProjectRootRef.current === normalizedProjectRoot) return

    restoredProjectRootRef.current = normalizedProjectRoot

    if (workbenchProjectFolderGroup) {
      const targetMember = getWorkbenchChatActiveProjectMember(
        workbenchProjectFolderGroup,
        normalizedProjectRoot
      )
      if (targetMember && workbenchProjectFolderGroup.folderId !== activeSessionId) {
        selectWorkbenchChatSessionMember(targetMember)
      }
      return
    }

    if (activeGroupId) return

    void startWorkbenchChatSession()
  }, [
    activeGroupId,
    activeSessionId,
    diskSessionHydrated,
    normalizedProjectRoot,
    selectWorkbenchChatSessionMember,
    startWorkbenchChatSession,
    workbenchProjectFolderGroup,
  ])

  const handleStartNewChat = (): void => {
    if (isStartNewChatDisabled) return

    void startWorkbenchChatSession()
    setDeleteDialogOpen(false)
    setSessionMenuOpen(false)
  }

  const handleArchiveSession = async (): Promise<void> => {
    if (isDeleteDisabled || !activeGroup) return

    try {
      await archiveSession(activeGroup.folderId)
      setDeleteDialogOpen(false)
    } catch (error) {
      onArchiveError?.(error)
    }
  }

  return (
    <section
      className={`${styles.workbenchChatPanel} ${styles.toolWindowPanel}`}
      aria-label={t('workbench.aiChatToolWindow')}
    >
      <header className={styles.workbenchChatTopBar}>
        <WorkbenchChatSessionMenu
          activeMemberSessionId={activeMemberSessionId}
          currentTitle={activeGroupLabel}
          disabled={!normalizedProjectRoot || isEmpty(workbenchProjectChatMembers)}
          fallbackTitle={t('sidebar.newChat')}
          members={workbenchProjectChatMembers}
          open={sessionMenuOpen}
          title={t('workbench.chatSessionSelect')}
          onOpenChange={setSessionMenuOpen}
          onSelectMember={selectWorkbenchChatSessionMember}
        />
        <IconButton
          variant="ghost"
          size="icon-sm"
          hoverBackground={false}
          className={styles.workbenchChatIconButton}
          label={t('workbench.newChatSession')}
          title={t('workbench.newChatSession')}
          disabled={isStartNewChatDisabled}
          data-active={!!pendingStartFolderId}
          onClick={handleStartNewChat}
        >
          <PlusIcon size={15} weight="bold" />
        </IconButton>
        <IconButton
          variant="ghost"
          size="icon-sm"
          hoverBackground={false}
          className={styles.workbenchChatIconButton}
          label={t('workbench.archiveChatSession')}
          title={t('workbench.archiveChatSession')}
          disabled={isDeleteDisabled}
          onClick={() => setDeleteDialogOpen(true)}
        >
          {isDeletingActiveGroup ? (
            <SpinnerGapIcon size={15} className={styles.spinIcon} />
          ) : (
            <ArchiveIcon size={15} />
          )}
        </IconButton>
      </header>
      <div className={styles.workbenchChatBody}>
        {ready ? (
          <WorkbenchChatSessionSurface
            providerId={providerId}
            conversationRefreshKey={conversationVersion}
            projectRoot={normalizedProjectRoot}
            currentFilePath={currentFilePath}
            pendingBrowserElementSelections={pendingBrowserElementSelections}
            onBrowserElementSelectionsConsumed={onBrowserElementSelectionsConsumed}
            onOpenFileChange={onOpenFileChange}
            onOpenWorkspacePath={onOpenWorkspacePath}
            onReviewFileChanges={onReviewFileChanges}
          />
        ) : (
          <div className={styles.workbenchChatLoading}>
            <SpinnerGapIcon size={16} className={styles.spinIcon} />
            <Text tone="caption">{t('chat.running')}</Text>
          </div>
        )}
      </div>
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          showClose={!isDeletingActiveGroup}
          className="velar-confirm-dialog"
          onInteractOutside={(event) => {
            event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t('sidebar.archiveDialogTitle', { title: activeGroupLabel })}
            </DialogTitle>
            <DialogDescription>{t('sidebar.archiveDialogDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={isDeletingActiveGroup}
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isDeleteDisabled}
              onClick={() => void handleArchiveSession()}
            >
              {isDeletingActiveGroup && <SpinnerGapIcon size={14} className={styles.spinIcon} />}
              {isDeletingActiveGroup
                ? t('sidebar.archivePendingAction')
                : t('sidebar.archiveConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
