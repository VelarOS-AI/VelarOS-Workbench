import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchBottomTool } from '@renderer/models/layout/workbenchSurfaceModel'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'
import type { ReactElement } from 'react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'

import styles from '../../styles/workbenchPageStyles'
import type {
  WorkbenchRunToolBundle,
  WorkbenchTerminalToolBundle,
} from '../../types/workbenchSurfaceBundles'

import {
  WorkbenchRunToolHeader,
  WorkbenchRunToolPane,
  WorkbenchTerminalToolHeader,
  WorkbenchTerminalToolPane,
} from './WorkbenchTerminalToolChrome'

export type BottomTool = WorkbenchBottomTool

interface CommandPanelProps {
  activeTool: BottomTool
  workbenchRun: WorkbenchRunToolBundle
  workbenchTerminal: WorkbenchTerminalToolBundle
  workbenchTheme: WorkbenchThemeId
  isCollapsed: boolean
  gitPanel: ReactElement
  problemsPanel: ReactElement
  onToggleCollapsed: () => void
  onCreateTerminalSession: () => void
  onActiveTerminalSessionChange: (sessionId: string) => void
  onCloseTerminalSession: (sessionId: string) => void
  /** xterm 收齐的按键原样送进伪终端（终端与运行卡同一条路）。 */
  onTerminalData: (sessionId: string, data: string) => void
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void
  onActiveRunSessionChange: (sessionId: string) => void
  onCloseRunSession: (sessionId: string) => void
  onRestartRunSession: (sessionId: string) => void
  onStopRunSession: (sessionId: string) => void
  onOpenConsoleLink?: (url: string) => void
}
export function CommandPanel({
  activeTool,
  workbenchRun: { runSessions, activeRunSessionId },
  workbenchTerminal: { terminalSessions, activeTerminalSessionId },
  workbenchTheme,
  isCollapsed,
  gitPanel,
  problemsPanel,
  onToggleCollapsed,
  onCreateTerminalSession,
  onActiveTerminalSessionChange,
  onCloseTerminalSession,
  onTerminalData,
  onTerminalResize,
  onActiveRunSessionChange,
  onCloseRunSession,
  onRestartRunSession,
  onStopRunSession,
  onOpenConsoleLink,
}: CommandPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()

  const activeToolTitle =
    activeTool === 'problems'
      ? t('workbench.editorProblems')
      : activeTool === 'terminal'
        ? t('workbench.commandTabTerminal')
        : activeTool === 'git'
          ? t('workbench.gitToolWindow')
          : t('workbench.commandTabRuns')

  return (
    <section className={styles.commandPanel} data-collapsed={isCollapsed}>
      <div className={styles.bottomToolMain}>
        {activeTool === 'terminal' ? (
          <WorkbenchTerminalToolHeader
            terminalSessions={terminalSessions}
            activeTerminalSessionId={activeTerminalSessionId}
            isCollapsed={isCollapsed}
            onCreateTerminalSession={onCreateTerminalSession}
            onActiveTerminalSessionChange={onActiveTerminalSessionChange}
            onCloseTerminalSession={onCloseTerminalSession}
            onToggleCollapsed={onToggleCollapsed}
          />
        ) : activeTool === 'run' && runSessions.length ? (
          <WorkbenchRunToolHeader
            runSessions={runSessions}
            activeRunSessionId={activeRunSessionId}
            isCollapsed={isCollapsed}
            onActiveRunSessionChange={onActiveRunSessionChange}
            onCloseRunSession={onCloseRunSession}
            onRestartRunSession={onRestartRunSession}
            onStopRunSession={onStopRunSession}
            onToggleCollapsed={onToggleCollapsed}
          />
        ) : (
          <div className={styles.bottomToolHeader}>
            <div className={styles.bottomToolTitleGroup}>
              <span className={styles.bottomToolTitle}>{activeToolTitle}</span>
            </div>
            <div className={styles.bottomToolActions}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={
                  isCollapsed ? t('workbench.expandToolWindow') : t('workbench.collapseToolWindow')
                }
                aria-label={
                  isCollapsed ? t('workbench.expandToolWindow') : t('workbench.collapseToolWindow')
                }
                onClick={onToggleCollapsed}
              >
                {isCollapsed ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
              </Button>
            </div>
          </div>
        )}

        {!isCollapsed && (
          <div className={styles.bottomToolBody}>
            {activeTool === 'run' && (
              <WorkbenchRunToolPane
                runSessions={runSessions}
                activeRunSessionId={activeRunSessionId}
                workbenchTheme={workbenchTheme}
                onTerminalData={onTerminalData}
                onTerminalResize={onTerminalResize}
                onOpenLink={onOpenConsoleLink}
              />
            )}

            {activeTool === 'problems' && (
              <div className={styles.problemsBottomPane}>{problemsPanel}</div>
            )}

            {activeTool === 'terminal' && (
              <WorkbenchTerminalToolPane
                terminalSessions={terminalSessions}
                activeTerminalSessionId={activeTerminalSessionId}
                workbenchTheme={workbenchTheme}
                onTerminalData={onTerminalData}
                onTerminalResize={onTerminalResize}
                onOpenLink={onOpenConsoleLink}
              />
            )}

            {activeTool === 'git' && <div className={styles.gitBottomPane}>{gitPanel}</div>}
          </div>
        )}
      </div>
    </section>
  )
}
