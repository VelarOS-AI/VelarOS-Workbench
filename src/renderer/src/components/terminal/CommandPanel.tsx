import { type ReactElement, useEffect, useRef } from 'react'
import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchBottomTool } from '@renderer/models/layout/workbenchSurfaceModel'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'

import styles from '../../styles/workbenchPageStyles'
import { useTimerScope } from '../../support/genericHooks'
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
  isCollapsed: boolean
  gitPanel: ReactElement
  problemsPanel: ReactElement
  onToggleCollapsed: () => void
  onCreateTerminalSession: () => void
  onActiveTerminalSessionChange: (sessionId: string) => void
  onTerminalInputChange: (sessionId: string, input: string) => void
  onRunTerminalInput: (sessionId: string) => void
  onCloseTerminalSession: (sessionId: string) => void
  onActiveRunSessionChange: (sessionId: string) => void
  onCloseRunSession: (sessionId: string) => void
  onRestartRunSession: (sessionId: string) => void
  onStopRunSession: (sessionId: string) => void
  onRunInputChange: (sessionId: string, input: string) => void
  onSubmitRunInput: (sessionId: string) => void
  onInterruptRunSession: (sessionId: string) => void
  onOpenConsoleLink?: (url: string) => void
}
export function CommandPanel({
  activeTool,
  workbenchRun: { runSessions, activeRunSessionId, commandHistory, runConfigurations, projectFiles },
  workbenchTerminal: { terminalSessions, activeTerminalSessionId },
  isCollapsed,
  gitPanel,
  problemsPanel,
  onToggleCollapsed,
  onCreateTerminalSession,
  onActiveTerminalSessionChange,
  onTerminalInputChange,
  onRunTerminalInput,
  onCloseTerminalSession,
  onActiveRunSessionChange,
  onCloseRunSession,
  onRestartRunSession,
  onStopRunSession,
  onRunInputChange,
  onSubmitRunInput,
  onInterruptRunSession,
  onOpenConsoleLink,
}: CommandPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const timers = useTimerScope('CommandPanel')
  const runOutputRef = useRef<HTMLDivElement>(null)
  const terminalOutputRef = useRef<HTMLDivElement>(null)
  const activeTerminalSession =
    terminalSessions.find((session) => session.id === activeTerminalSessionId) ??
    terminalSessions[0]
  const activeRunSession =
    runSessions.find((session) => session.id === activeRunSessionId) ?? runSessions[0]

  useEffect(() => {
    if (activeTool !== 'run') return

    timers.nextFrame(
      () => {
        const node = runOutputRef.current
        if (node) {
          node.scrollTop = node.scrollHeight
        }
      },
      { label: 'workbench.runOutput.scrollToBottom' }
    )
  }, [activeRunSession?.lines.length, activeTool, timers])

  useEffect(() => {
    if (activeTool !== 'terminal') return

    timers.nextFrame(
      () => {
        const node = terminalOutputRef.current
        if (node) {
          node.scrollTop = node.scrollHeight
        }
      },
      { label: 'workbench.terminal.scrollToBottom' }
    )
  }, [activeTerminalSession?.lines.length, activeTool, timers])

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
          <>
            <div className={styles.bottomToolBody}>
              {activeTool === 'run' && (
                <WorkbenchRunToolPane
                  runSessions={runSessions}
                  activeRunSessionId={activeRunSessionId}
                  outputRef={runOutputRef}
                  onRunInputChange={onRunInputChange}
                  onSubmitRunInput={onSubmitRunInput}
                  onInterruptRunSession={onInterruptRunSession}
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
                  commandHistory={commandHistory}
                  projectFiles={projectFiles}
                  runConfigurations={runConfigurations}
                  outputRef={terminalOutputRef}
                  onTerminalInputChange={onTerminalInputChange}
                  onRunTerminalInput={onRunTerminalInput}
                  onOpenLink={onOpenConsoleLink}
                />
              )}

              {activeTool === 'git' && <div className={styles.gitBottomPane}>{gitPanel}</div>}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
