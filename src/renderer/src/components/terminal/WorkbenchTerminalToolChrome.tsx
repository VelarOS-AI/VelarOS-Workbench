import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowClockwiseIcon,
  BrowsersIcon,
  MinusIcon,
  PlusIcon,
  StopIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useWorkbenchTerminalCompletionInteractions } from '@renderer/components/terminal/useWorkbenchTerminalCompletionInteractions'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchCommandHistoryItem } from '@renderer/models/commands/workbenchCommandHistory'
import type { WorkbenchTerminalSessionView } from '@renderer/models/commands/workbenchCommandLines'
import { highlightWorkbenchConsoleOutputSequence } from '@renderer/models/commands/workbenchConsoleOutputHighlight'
import type { WorkbenchRunConfiguration } from '@renderer/models/commands/workbenchRunConfigurations'
import { formatWorkbenchTerminalPrompt } from '@renderer/models/commands/workbenchTerminalPresentation'
import type { WorkbenchProjectContextFile } from '@renderer/models/project/workbenchProjectContextIndex'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import styles from '../../styles/workbenchPageStyles'

import { WorkbenchConsoleOutputLine } from './WorkbenchConsoleOutputLine'

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
            className={styles.terminalToolHeaderIconButton}
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
          className={styles.terminalToolHeaderIconButton}
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

interface WorkbenchTerminalToolPaneProps {
  terminalSessions: WorkbenchTerminalSessionView[]
  activeTerminalSessionId: Nullable<string>
  commandHistory: readonly WorkbenchCommandHistoryItem[]
  projectFiles: readonly WorkbenchProjectContextFile[]
  runConfigurations: readonly WorkbenchRunConfiguration[]
  outputRef: RefObject<HTMLDivElement | null>
  onTerminalInputChange: (sessionId: string, input: string) => void
  onRunTerminalInput: (sessionId: string) => void
  onOpenLink?: (url: string) => void
}

export function WorkbenchTerminalToolPane({
  terminalSessions,
  activeTerminalSessionId,
  commandHistory,
  projectFiles,
  runConfigurations,
  outputRef,
  onTerminalInputChange,
  onRunTerminalInput,
  onOpenLink,
}: WorkbenchTerminalToolPaneProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState({ index: 0, scrollLeft: 0 })
  const { activeTerminalSession, handleTerminalKeyDown } =
    useWorkbenchTerminalCompletionInteractions({
      terminalSessions,
      activeTerminalSessionId,
      commandHistory,
      projectFiles,
      runConfigurations,
      onTerminalInputChange,
      onRunTerminalInput,
    })

  function syncCaret(input: HTMLInputElement): void {
    setCaret({ index: input.selectionStart ?? input.value.length, scrollLeft: input.scrollLeft })
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [activeTerminalSession?.id])

  // Keep the block caret aligned when the input value changes from outside typing
  // (history navigation, completion insertion) rather than a keystroke.
  useEffect(() => {
    if (inputRef.current) syncCaret(inputRef.current)
  }, [activeTerminalSession?.input])

  const highlightedLines = useMemo(
    () =>
      highlightWorkbenchConsoleOutputSequence(
        activeTerminalSession?.lines.map(({ text, stream }) => ({
          text,
          stream,
        })) ?? []
      ),
    [activeTerminalSession?.lines]
  )

  function submitTerminalInput(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!activeTerminalSession) return

    onRunTerminalInput(activeTerminalSession.id)
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    handleTerminalKeyDown(event)
  }

  if (!activeTerminalSession)
    return (
      <Paragraph spacing="none" className={styles.commandEmpty}>
        {t('workbench.terminalEmpty')}
      </Paragraph>
    )

  const prompt = formatWorkbenchTerminalPrompt(activeTerminalSession)

  return (
    <div className={styles.terminalToolPane}>
      <ScrollArea ref={outputRef} className={styles.terminalOutputScroll}>
        <div className={styles.terminalOutput}>
          {activeTerminalSession.lines.map((line, index) => (
            <WorkbenchConsoleOutputLine
              key={line.id}
              text={line.text}
              tokens={highlightedLines[index]}
              stream={line.stream}
              className={styles.terminalOutputLine}
              onOpenLink={onOpenLink}
            />
          ))}
          {activeTerminalSession.isRunning && (
            <form className={styles.terminalPromptRow} onSubmit={submitTerminalInput}>
              <span className={styles.terminalPromptLabel}>{prompt}</span>
              <span className={styles.terminalPromptField}>
                <input
                  ref={inputRef}
                  className={styles.terminalPromptInput}
                  value={activeTerminalSession.input}
                  aria-label={t('workbench.terminalPlaceholder')}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(event) => {
                    onTerminalInputChange(activeTerminalSession.id, event.target.value)
                    syncCaret(event.currentTarget)
                  }}
                  onKeyUp={(event) => syncCaret(event.currentTarget)}
                  onClick={(event) => syncCaret(event.currentTarget)}
                  onSelect={(event) => syncCaret(event.currentTarget)}
                  onScroll={(event) => syncCaret(event.currentTarget)}
                  onKeyDown={handleInputKeyDown}
                />
                <span
                  aria-hidden
                  className={styles.terminalPromptCaret}
                  style={{ transform: `translateX(calc(${caret.index}ch - ${caret.scrollLeft}px))` }}
                />
              </span>
            </form>
          )}
        </div>
      </ScrollArea>
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
            className={styles.terminalToolHeaderIconButton}
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
            className={`${styles.terminalToolHeaderIconButton} ${styles.runStopButton}`}
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
          className={styles.terminalToolHeaderIconButton}
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

interface WorkbenchRunToolPaneProps {
  runSessions: WorkbenchTerminalSessionView[]
  activeRunSessionId: Nullable<string>
  outputRef: RefObject<HTMLDivElement | null>
  onRunInputChange: (sessionId: string, input: string) => void
  onSubmitRunInput: (sessionId: string) => void
  onInterruptRunSession: (sessionId: string) => void
  onOpenLink?: (url: string) => void
}

export function WorkbenchRunToolPane({
  runSessions,
  activeRunSessionId,
  outputRef,
  onRunInputChange,
  onSubmitRunInput,
  onInterruptRunSession,
  onOpenLink,
}: WorkbenchRunToolPaneProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRunSession =
    runSessions.find((session) => session.id === activeRunSessionId) ?? runSessions[0]

  useEffect(() => {
    inputRef.current?.focus()
  }, [activeRunSession?.id])

  const highlightedLines = useMemo(
    () =>
      highlightWorkbenchConsoleOutputSequence(
        activeRunSession?.lines.map(({ text, stream }) => ({ text, stream })) ?? []
      ),
    [activeRunSession?.lines]
  )

  if (!activeRunSession)
    return (
      <Paragraph spacing="none" className={styles.commandEmpty}>
        {t('workbench.runEmptyHint')}
      </Paragraph>
    )

  const sessionId = activeRunSession.id

  function submitRunInput(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmitRunInput(sessionId)
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Ctrl+C → 向前台进程发送 SIGINT（真终端语义）。
    if (event.ctrlKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault()
      onInterruptRunSession(sessionId)
    }
  }

  return (
    <div className={styles.terminalToolPane}>
      <ScrollArea ref={outputRef} className={styles.terminalOutputScroll}>
        <div className={styles.terminalOutput}>
          {activeRunSession.lines.map((line, index) => (
            <WorkbenchConsoleOutputLine
              key={line.id}
              text={line.text}
              tokens={highlightedLines[index]}
              stream={line.stream}
              className={styles.terminalOutputLine}
              onOpenLink={onOpenLink}
            />
          ))}
          {activeRunSession.isRunning && (
            <form className={styles.terminalPromptRow} onSubmit={submitRunInput}>
              <span className={styles.terminalPromptField}>
                <input
                  ref={inputRef}
                  className={styles.terminalPromptInput}
                  value={activeRunSession.input}
                  aria-label={t('workbench.runInputPlaceholder')}
                  placeholder={t('workbench.runInputPlaceholder')}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(event) => onRunInputChange(sessionId, event.target.value)}
                  onKeyDown={handleInputKeyDown}
                />
              </span>
            </form>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
