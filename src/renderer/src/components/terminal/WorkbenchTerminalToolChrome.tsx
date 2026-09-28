import { lazy, type ReactElement, Suspense } from 'react'
import {
  ArrowClockwiseIcon,
  BrowsersIcon,
  MinusIcon,
  PlusIcon,
  StopIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchTerminalSessionView } from '@renderer/models/commands/workbenchCommandLines'
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
  onActiveTerminalSessionChange: (sessionId: string) => void
  onCloseTerminalSession: (sessionId: string) => void
  onToggleCollapsed: () => void
}
export function WorkbenchTerminalToolHeader({
  terminalSessions,
  activeTerminalSessionId,
  isCollapsed,
  onCreateTerminalSession,
  onActiveTerminalSessionChange,
  onCloseTerminalSession,
  onToggleCollapsed,
}: WorkbenchTerminalToolHeaderProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const activeTerminalSession =
    terminalSessions.find((session) => session.id === activeTerminalSessionId) ??
    terminalSessions[0]

  return (
    <div className={styles.terminalToolHeader} data-terminal-chrome="true">
      <div className={styles.terminalToolHeaderLeading}>
        <span className={styles.terminalToolHeaderLabel}>{t('workbench.commandTabTerminal')}</span>
        <div className={styles.terminalSessionTabStrip} role="tablist">
          {terminalSessions.map((session) => {
            const isActive = session.id === activeTerminalSession?.id

            return (
              <button
                key={session.id}
                type="button"
                className={styles.terminalSessionTab}
                data-active={isActive}
                data-running={session.isRunning}
                title={session.title}
                role="tab"
                aria-selected={isActive}
                onClick={() => onActiveTerminalSessionChange(session.id)}
              >
                <span className={styles.terminalSessionTabLabel}>{session.title}</span>
                <span
                  className={styles.terminalSessionTabClose}
                  aria-label={t('common.close')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseTerminalSession(session.id)
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

interface WorkbenchTerminalToolPaneProps extends WorkbenchTerminalSurfaceHandlers {
  terminalSessions: WorkbenchTerminalSessionView[]
  activeTerminalSessionId: Nullable<string>
}

export function WorkbenchTerminalToolPane({
  terminalSessions,
  activeTerminalSessionId,
  ...surface
}: WorkbenchTerminalToolPaneProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const activeTerminalSession =
    terminalSessions.find((session) => session.id === activeTerminalSessionId) ??
    terminalSessions[0]

  if (!activeTerminalSession)
    return (
      <Paragraph spacing="none" className={styles.commandEmpty}>
        {t('workbench.terminalEmpty')}
      </Paragraph>
    )

  return <WorkbenchTerminalSurface session={activeTerminalSession} {...surface} />
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
