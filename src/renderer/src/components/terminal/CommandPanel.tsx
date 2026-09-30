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
  type WorkbenchTerminalSurfaceHandlers,
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
  /** 调试面板（按需加载，由页面给）。 */
  debugPanel: ReactElement
  gitPanel: ReactElement
  problemsPanel: ReactElement
  onToggleCollapsed: () => void
  onCreateTerminalSession: () => void
  /** 在一个终端右边并排再开一个；不指明就是当前那个。 */
  onSplitTerminalSession: (sessionId?: string) => void
  onActiveTerminalSessionChange: (sessionId: string) => void
  onCloseTerminalSessions: (sessionIds: readonly string[]) => void
  onTerminalPaneWeightsChange: (weights: Readonly<Record<string, number>>) => void
  /** xterm 收齐的按键原样送进伪终端（终端与运行卡同一条路）。 */
  onTerminalData: (sessionId: string, data: string) => void
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void
  onActiveRunSessionChange: (sessionId: string) => void
  onCloseRunSession: (sessionId: string) => void
  onRestartRunSession: (sessionId: string) => void
  onStopRunSession: (sessionId: string) => void
  onOpenConsoleLink?: (url: string) => void
  onResolveTerminalFileLinks?: WorkbenchTerminalSurfaceHandlers['onResolveFileLinks']
  onOpenTerminalFileLink?: WorkbenchTerminalSurfaceHandlers['onOpenFileLink']
}
export function CommandPanel({
  activeTool,
  workbenchRun: { runSessions, activeRunSessionId },
  workbenchTerminal: { terminalSessions, activeTerminalSessionId },
  workbenchTheme,
  isCollapsed,
  debugPanel,
  gitPanel,
  problemsPanel,
  onToggleCollapsed,
  onCreateTerminalSession,
  onSplitTerminalSession,
  onActiveTerminalSessionChange,
  onCloseTerminalSessions,
  onTerminalPaneWeightsChange,
  onTerminalData,
  onTerminalResize,
  onActiveRunSessionChange,
  onCloseRunSession,
  onRestartRunSession,
  onStopRunSession,
  onOpenConsoleLink,
  onResolveTerminalFileLinks,
  onOpenTerminalFileLink,
}: CommandPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()

  const activeToolTitle =
    activeTool === 'problems'
      ? t('workbench.editorProblems')
      : activeTool === 'terminal'
        ? t('workbench.commandTabTerminal')
        : activeTool === 'git'
          ? t('workbench.gitToolWindow')
          : activeTool === 'debug'
            ? t('workbench.debuggerToolWindow')
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
            onSplitTerminalSession={() => onSplitTerminalSession()}
            onActiveTerminalSessionChange={onActiveTerminalSessionChange}
            onCloseTerminalSessions={onCloseTerminalSessions}
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
                onResolveFileLinks={onResolveTerminalFileLinks}
                onOpenFileLink={onOpenTerminalFileLink}
              />
            )}

            {activeTool === 'problems' && (
              <div className={styles.problemsBottomPane}>{problemsPanel}</div>
            )}

            {activeTool === 'terminal' && (
              <WorkbenchTerminalToolPane
                terminalSessions={terminalSessions}
                activeTerminalSessionId={activeTerminalSessionId}
                onActiveTerminalSessionChange={onActiveTerminalSessionChange}
                onSplitTerminalSession={onSplitTerminalSession}
                onCloseTerminalSessions={onCloseTerminalSessions}
                onTerminalPaneWeightsChange={onTerminalPaneWeightsChange}
                workbenchTheme={workbenchTheme}
                onTerminalData={onTerminalData}
                onTerminalResize={onTerminalResize}
                onOpenLink={onOpenConsoleLink}
                onResolveFileLinks={onResolveTerminalFileLinks}
                onOpenFileLink={onOpenTerminalFileLink}
              />
            )}

            {activeTool === 'git' && <div className={styles.gitBottomPane}>{gitPanel}</div>}

            {activeTool === 'debug' && debugPanel}
          </div>
        )}
      </div>
    </section>
  )
}
