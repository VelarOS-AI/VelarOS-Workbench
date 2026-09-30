import {
  Fragment,
  lazy,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  Suspense,
  useEffect,
  useRef,
} from 'react'
import {
  ArrowClockwiseIcon,
  BrowsersIcon,
  MinusIcon,
  PlusIcon,
  SquareSplitHorizontalIcon,
  StopIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchTerminalSessionView } from '@renderer/models/commands/workbenchCommandLines'
import {
  adjacentWorkbenchTerminalPane,
  findActiveWorkbenchTerminalGroup,
  groupWorkbenchTerminalSessions,
  resizeWorkbenchTerminalPanes,
  type WorkbenchTerminalGroup,
  type WorkbenchTerminalPaneAction,
  workbenchTerminalPaneShares,
  workbenchTerminalSplitShortcut,
} from '@renderer/models/commands/workbenchTerminalSplits'
import {
  formatWorkbenchShortcutHint,
  isAppleWorkbenchPlatform,
} from '@renderer/models/layout/workbenchKeyboardShortcuts'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'

import styles from '../../styles/workbenchPageStyles'

// xterm 及其渲染器只在真的打开终端 / 运行卡时才加载，不进启动包。
const LazyWorkbenchTerminalView = lazy(async () => {
  const module = await import('./WorkbenchTerminalView')
  return { default: module.WorkbenchTerminalView }
})

/** 终端与运行卡共用的 xterm 面：只挂当前会话，其余会话的 xterm 实例留在表里等切回来。 */
export interface WorkbenchTerminalSurfaceHandlers {
  workbenchTheme: WorkbenchThemeId
  onTerminalData: (sessionId: string, data: string) => void
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void
  onOpenLink?: (url: string) => void
  /** 输出里的路径各是项目里的哪个文件（不是的给 null）；是文件的才能点开。 */
  onResolveFileLinks?: (paths: readonly string[], cwd: string) => Promise<Array<Nullable<string>>>
  onOpenFileLink?: (path: string, line?: number, column?: number) => void
}

function WorkbenchTerminalSurface({
  session,
  workbenchTheme,
  onTerminalData,
  onTerminalResize,
  onOpenLink,
  onResolveFileLinks,
  onOpenFileLink,
}: WorkbenchTerminalSurfaceHandlers & { session: WorkbenchTerminalSessionView }): ReactElement {
  return (
    <div className={styles.terminalToolPane}>
      <Suspense fallback={null}>
        <LazyWorkbenchTerminalView
          key={session.id}
          sessionId={session.id}
          cwd={session.cwd}
          isRunning={session.isRunning}
          workbenchTheme={workbenchTheme}
          onData={onTerminalData}
          onResize={onTerminalResize}
          onOpenLink={onOpenLink}
          onResolveFileLinks={onResolveFileLinks}
          onOpenFileLink={onOpenFileLink}
        />
      </Suspense>
    </div>
  )
}

interface WorkbenchTerminalToolHeaderProps {
  terminalSessions: WorkbenchTerminalSessionView[]
  activeTerminalSessionId: Nullable<string>
  isCollapsed: boolean
  onCreateTerminalSession: () => void
  /** 在当前终端右边并排再开一个。 */
  onSplitTerminalSession: () => void
  onActiveTerminalSessionChange: (sessionId: string) => void
  onCloseTerminalSessions: (sessionIds: readonly string[]) => void
  onToggleCollapsed: () => void
}

/** 终端的标签栏：一个标签是并排的一组终端（没拆分过就一个），关标签把这一组都关掉。 */
export function WorkbenchTerminalToolHeader({
  terminalSessions,
  activeTerminalSessionId,
  isCollapsed,
  onCreateTerminalSession,
  onSplitTerminalSession,
  onActiveTerminalSessionChange,
  onCloseTerminalSessions,
  onToggleCollapsed,
}: WorkbenchTerminalToolHeaderProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const groups = groupWorkbenchTerminalSessions(terminalSessions)
  const activeGroup = findActiveWorkbenchTerminalGroup(terminalSessions, activeTerminalSessionId)
  // 每个标签里上次停在并排的哪一个：切回这个标签时回到那一个。
  const lastActiveByGroup = useRef(new Map<string, string>())
  const activeGroupId = activeGroup?.id
  useEffect(() => {
    if (activeGroupId && activeTerminalSessionId)
      lastActiveByGroup.current.set(activeGroupId, activeTerminalSessionId)
  }, [activeGroupId, activeTerminalSessionId])
  const splitLabel = `${t('workbench.terminalSplit')} (${formatWorkbenchShortcutHint(
    workbenchTerminalSplitShortcut(isAppleWorkbenchPlatform())
  )})`

  return (
    <div className={styles.terminalToolHeader} data-terminal-chrome="true">
      <div className={styles.terminalToolHeaderLeading}>
        <span className={styles.terminalToolHeaderLabel}>{t('workbench.commandTabTerminal')}</span>
        <div className={styles.terminalSessionTabStrip} role="tablist">
          {groups.map((group) => {
            const isActive = group.id === activeGroupId
            const first = group.sessions[0]!

            return (
              <button
                key={group.id}
                type="button"
                className={styles.terminalSessionTab}
                data-active={isActive}
                data-running={group.sessions.some((session) => session.isRunning)}
                title={first.title}
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  // 已经在这一组里就不动：当前是并排里的哪一个保持原样。
                  if (isActive) return
                  const last = lastActiveByGroup.current.get(group.id)
                  onActiveTerminalSessionChange(
                    group.sessions.some((session) => session.id === last) && last ? last : first.id
                  )
                }}
              >
                <span className={styles.terminalSessionTabLabel}>{first.title}</span>
                <span
                  className={styles.terminalSessionTabClose}
                  aria-label={t('common.close')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseTerminalSessions(group.sessions.map((session) => session.id))
                  }}
                >
                  <XIcon size={11} />
                </span>
              </button>
            )
          })}
        </div>
        <div className={styles.terminalToolHeaderTabActions}>
          <IconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t('workbench.terminalNew')}
            label={t('workbench.terminalNew')}
            onClick={onCreateTerminalSession}
          >
            <PlusIcon size={13} />
          </IconButton>
          <IconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            title={splitLabel}
            label={splitLabel}
            disabled={!activeGroup}
            onClick={onSplitTerminalSession}
          >
            <SquareSplitHorizontalIcon size={13} />
          </IconButton>
        </div>
      </div>
      <div className={styles.terminalToolHeaderTrailing}>
        <IconButton
          type="button"
          variant="ghost"
          size="icon-sm"
          title={isCollapsed ? t('workbench.expandToolWindow') : t('workbench.collapseToolWindow')}
          label={isCollapsed ? t('workbench.expandToolWindow') : t('workbench.collapseToolWindow')}
          onClick={onToggleCollapsed}
        >
          <MinusIcon size={14} />
        </IconButton>
      </div>
    </div>
  )
}

interface WorkbenchTerminalSplitHandlers {
  onActiveTerminalSessionChange: (sessionId: string) => void
  /** 在这个终端右边并排再开一个。 */
  onSplitTerminalSession: (sessionId: string) => void
  onCloseTerminalSessions: (sessionIds: readonly string[]) => void
  /** 拖完分隔条：各个终端占的宽度份额。 */
  onTerminalPaneWeightsChange: (weights: Readonly<Record<string, number>>) => void
}

interface WorkbenchTerminalToolPaneProps
  extends WorkbenchTerminalSurfaceHandlers, WorkbenchTerminalSplitHandlers {
  terminalSessions: WorkbenchTerminalSessionView[]
  activeTerminalSessionId: Nullable<string>
}

export function WorkbenchTerminalToolPane({
  terminalSessions,
  activeTerminalSessionId,
  ...handlers
}: WorkbenchTerminalToolPaneProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const group = findActiveWorkbenchTerminalGroup(terminalSessions, activeTerminalSessionId)

  if (!group)
    return (
      <Paragraph spacing="none" className={styles.commandEmpty}>
        {t('workbench.terminalEmpty')}
      </Paragraph>
    )

  return (
    <WorkbenchTerminalSplitGroup
      key={group.id}
      group={group}
      activeSessionId={activeTerminalSessionId}
      sessionCount={terminalSessions.length}
      {...handlers}
    />
  )
}

/**
 * 一个标签里并排的终端：从左到右排开，中间的分隔条可以拖（双击恢复成一样宽）。只有当前那个拿焦点；
 * 并排不止一个时每个右上角有自己的关闭按钮。
 */
function WorkbenchTerminalSplitGroup({
  group,
  activeSessionId,
  sessionCount,
  onActiveTerminalSessionChange,
  onSplitTerminalSession,
  onCloseTerminalSessions,
  onTerminalPaneWeightsChange,
  workbenchTheme,
  onTerminalData,
  onTerminalResize,
  onOpenLink,
  onResolveFileLinks,
  onOpenFileLink,
}: WorkbenchTerminalSurfaceHandlers &
  WorkbenchTerminalSplitHandlers & {
    group: WorkbenchTerminalGroup
    activeSessionId: Nullable<string>
    /** 所有标签里的终端一共几个。 */
    sessionCount: number
  }): ReactElement {
  const { t } = useWorkbenchI18n()
  const groupRef = useRef<HTMLDivElement>(null)
  const sessions = group.sessions
  const shares = workbenchTerminalPaneShares(sessions)
  const isSplit = sessions.length > 1
  const activeId = sessions.some((session) => session.id === activeSessionId)
    ? activeSessionId
    : sessions[0]!.id

  const handlePaneAction = (sessionId: string, action: WorkbenchTerminalPaneAction): boolean => {
    if (action === 'split') {
      onSplitTerminalSession(sessionId)
      return true
    }
    const beside = adjacentWorkbenchTerminalPane(
      sessions,
      sessionId,
      action === 'focus-next' ? 1 : -1
    )
    if (!beside) return false
    onActiveTerminalSessionChange(beside)
    return true
  }

  const commitShares = (next: readonly number[]): void =>
    onTerminalPaneWeightsChange(
      Object.fromEntries(sessions.map((session, index) => [session.id, next[index] ?? 1]))
    )

  const beginResize = (divider: number, event: ReactPointerEvent<HTMLDivElement>): void => {
    const container = groupRef.current
    if (!container || event.button !== 0) return
    event.preventDefault()

    const handle = event.currentTarget
    const panes = [...container.querySelectorAll<HTMLElement>(':scope > [data-terminal-pane]')]
    const width = container.clientWidth
    const startX = event.clientX
    let next: readonly number[] = shares
    handle.setPointerCapture(event.pointerId)

    // 拖的时候直接改样式，不逐帧过 React；松手再把份额记下来。
    const move = (moveEvent: PointerEvent): void => {
      if (width <= 0) return
      next = resizeWorkbenchTerminalPanes(shares, divider, (moveEvent.clientX - startX) / width)
      panes.forEach((pane, index) => {
        pane.style.flexGrow = String(next[index] ?? 1)
      })
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      commitShares(next)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  return (
    <div ref={groupRef} className={styles.terminalSplitGroup} data-terminal-split-group="true">
      {sessions.map((session, index) => (
        <Fragment key={session.id}>
          {index > 0 && (
            <div
              className={`${styles.verticalResizeHandle} ${styles.terminalSplitResizeHandle}`}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('workbench.terminalResizeSplit')}
              onPointerDown={(event) => beginResize(index - 1, event)}
              onDoubleClick={() => commitShares(sessions.map(() => 1))}
            />
          )}
          <div
            className={styles.terminalSplitPane}
            data-terminal-pane="true"
            data-active={session.id === activeId}
            style={{ flexGrow: shares[index] }}
          >
            <Suspense fallback={null}>
              <LazyWorkbenchTerminalView
                sessionId={session.id}
                cwd={session.cwd}
                isRunning={session.isRunning}
                workbenchTheme={workbenchTheme}
                onData={onTerminalData}
                onResize={onTerminalResize}
                onOpenLink={onOpenLink}
                onResolveFileLinks={onResolveFileLinks}
                onOpenFileLink={onOpenFileLink}
                isActive={session.id === activeId}
                sessionCount={sessionCount}
                onActivate={() => {
                  if (session.id !== activeId) onActiveTerminalSessionChange(session.id)
                }}
                onPaneAction={(action) => handlePaneAction(session.id, action)}
              />
            </Suspense>
            {isSplit && (
              <button
                type="button"
                className={styles.terminalSplitPaneClose}
                title={t('workbench.terminalClosePane')}
                aria-label={t('workbench.terminalClosePane')}
                onClick={() => onCloseTerminalSessions([session.id])}
              >
                <XIcon size={12} />
              </button>
            )}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

interface WorkbenchRunToolHeaderProps {
  runSessions: WorkbenchTerminalSessionView[]
  activeRunSessionId: Nullable<string>
  isCollapsed: boolean
  onActiveRunSessionChange: (sessionId: string) => void
  onCloseRunSession: (sessionId: string) => void
  onRestartRunSession: (sessionId: string) => void
  onStopRunSession: (sessionId: string) => void
  onToggleCollapsed: () => void
}

export function WorkbenchRunToolHeader({
  runSessions,
  activeRunSessionId,
  isCollapsed,
  onActiveRunSessionChange,
  onCloseRunSession,
  onRestartRunSession,
  onStopRunSession,
  onToggleCollapsed,
}: WorkbenchRunToolHeaderProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const activeRunSession =
    runSessions.find((session) => session.id === activeRunSessionId) ?? runSessions[0]
  const activeId = activeRunSession?.id
  const canRestart = !!activeRunSession?.command
  const canStop = activeRunSession?.isRunning

  return (
    <div className={styles.terminalToolHeader} data-terminal-chrome="true">
      <div className={styles.terminalToolHeaderLeading}>
        <span className={styles.terminalToolHeaderLabel}>{t('workbench.commandTabRuns')}</span>
        <div className={styles.terminalSessionTabStrip} role="tablist">
          {runSessions.map((session) => {
            const isActive = session.id === activeRunSession?.id

            return (
              <button
                key={session.id}
                type="button"
                className={styles.terminalSessionTab}
                data-active={isActive}
                data-kind="run"
                data-running={session.isRunning}
                title={session.command || session.title}
                role="tab"
                aria-selected={isActive}
                onClick={() => onActiveRunSessionChange(session.id)}
              >
                <span className={styles.runSessionTabIcon} aria-hidden="true">
                  <BrowsersIcon size={14} />
                  {session.isRunning && <span className={styles.runSessionTabRunningDot} />}
                </span>
                <span className={styles.terminalSessionTabLabel}>{session.title}</span>
                <span
                  className={styles.terminalSessionTabClose}
                  aria-label={t('common.close')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseRunSession(session.id)
                  }}
                >
                  <XIcon size={11} />
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className={styles.terminalToolHeaderTrailing}>
        <div className={styles.runToolbar}>
          <IconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t('workbench.runRestart')}
            label={t('workbench.runRestart')}
            disabled={!canRestart}
            onClick={() => activeId && onRestartRunSession(activeId)}
          >
            <ArrowClockwiseIcon size={14} />
          </IconButton>
          <IconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className={styles.runStopButton}
            title={t('workbench.runStop')}
            label={t('workbench.runStop')}
            disabled={!canStop}
            onClick={() => activeId && onStopRunSession(activeId)}
          >
            <StopIcon size={14} weight="fill" />
          </IconButton>
        </div>
        <IconButton
          type="button"
          variant="ghost"
          size="icon-sm"
          title={isCollapsed ? t('workbench.expandToolWindow') : t('workbench.collapseToolWindow')}
          label={isCollapsed ? t('workbench.expandToolWindow') : t('workbench.collapseToolWindow')}
          onClick={onToggleCollapsed}
        >
          <MinusIcon size={14} />
        </IconButton>
      </div>
    </div>
  )
}

interface WorkbenchRunToolPaneProps extends WorkbenchTerminalSurfaceHandlers {
  runSessions: WorkbenchTerminalSessionView[]
  activeRunSessionId: Nullable<string>
}

export function WorkbenchRunToolPane({
  runSessions,
  activeRunSessionId,
  ...surface
}: WorkbenchRunToolPaneProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const activeRunSession =
    runSessions.find((session) => session.id === activeRunSessionId) ?? runSessions[0]

  if (!activeRunSession)
    return (
      <Paragraph spacing="none" className={styles.commandEmpty}>
        {t('workbench.runEmptyHint')}
      </Paragraph>
    )

  return <WorkbenchTerminalSurface session={activeRunSession} {...surface} />
}
