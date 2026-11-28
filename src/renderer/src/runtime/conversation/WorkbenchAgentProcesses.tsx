import { type ReactElement, useEffect, useRef, useState } from 'react'
import { TerminalWindowIcon } from '@phosphor-icons/react'
import { WorkbenchConsoleOutputLine } from '@renderer/components/terminal/WorkbenchConsoleOutputLine'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import { AppError } from '@velaros-ai/velaros/core/error'
import type { ShellBackgroundTaskRecord } from '@velaros-ai/velaros/execution/contracts'

import type { WorkbenchConversationSessionRequest } from '@shared/workbenchConversation'

import styles from '../../styles/WorkbenchAgentProcesses.module.css'

type OpenConsoleLink = (url: string) => void

function ProcessOutput({
  text,
  label,
  onOpenLink,
}: {
  text: string
  label: string
  onOpenLink?: OpenConsoleLink
}): ReactElement {
  const outputRef = useRef<HTMLDivElement>(null)
  const followOutput = useRef(true)
  useEffect(() => {
    const output = outputRef.current
    if (output && followOutput.current) output.scrollTop = output.scrollHeight
  }, [text])
  return (
    <div
      ref={outputRef}
      className={styles.output}
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => {
        const output = event.currentTarget
        followOutput.current = output.scrollHeight - output.scrollTop - output.clientHeight < 24
      }}
    >
      <WorkbenchConsoleOutputLine
        className={styles.outputLine}
        text={text.replace(/\r\n?/gu, '\n')}
        onOpenLink={onOpenLink}
      />
    </div>
  )
}

/** 开发服务器和交互式命令跨回合保留；运行面板可见时持续刷新输出。 */
export function WorkbenchAgentProcesses({
  projectRoot,
  sessionId,
  onOpenLink,
}: WorkbenchConversationSessionRequest & { onOpenLink?: OpenConsoleLink }): ReactElement {
  const { t } = useWorkbenchI18n()
  const [selectedTaskId, setSelectedTaskId] = useState<Nullable<string>>(null)
  const [tasks, setTasks] = useState<readonly ShellBackgroundTaskRecord[]>([])
  const [loadError, setLoadError] = useState<Nullable<string>>(null)
  const [error, setError] = useState<Nullable<string>>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  useEffect(() => {
    let disposed = false
    let pending = false
    let dirty = false
    const load = async (): Promise<void> => {
      dirty = true
      if (pending) return
      pending = true
      try {
        do {
          dirty = false
          const result = await window.velarosWorkbenchAgentProcesses.list({
            projectRoot,
            sessionId,
          })
          if (disposed) return
          if (!result.ok) throw new AppError('UNAVAILABLE', result.message)
          setTasks(result.value)
          setLoadError(null)
        } while (dirty && !disposed)
      } catch (failure) {
        if (!disposed) setLoadError(AppError.getMessage(failure))
      } finally {
        pending = false
      }
    }
    const off = window.velarosWorkbenchAgentProcesses.onChanged((ref) => {
      if (ref.projectRoot === projectRoot && ref.sessionId === sessionId) void load()
    })
    void load()
    const timer = setInterval(() => void load(), 1000)
    return () => {
      disposed = true
      off()
      clearInterval(timer)
    }
  }, [projectRoot, sessionId, revision])

  const act = async (
    taskId: string,
    action: 'stop' | 'force' | 'input' | 'interrupt'
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    const request = { projectRoot, sessionId, taskId }
    try {
      const bridge = window.velarosWorkbenchAgentProcesses
      const result =
        action === 'input'
          ? await bridge.input({ ...request, text: inputs[taskId] ?? '' })
          : action === 'interrupt'
            ? await bridge.interrupt(request)
            : await bridge.stop({ ...request, force: action === 'force' })
      if (!result.ok) throw new AppError('UNAVAILABLE', result.message)
      if ('accepted' in result.value && !result.value.accepted)
        throw new AppError('UNAVAILABLE', result.value.message)
      if ('statusAfter' in result.value && result.value.statusAfter !== 'exited')
        throw new AppError('UNAVAILABLE', result.value.message)
      if (action === 'input') setInputs((current) => ({ ...current, [taskId]: '' }))
    } catch (failure) {
      setError(AppError.getMessage(failure))
    } finally {
      setBusy(false)
      setRevision((current) => current + 1)
    }
  }
  const selected =
    tasks.find((task) => task.id === selectedTaskId) ??
    tasks.find((task) => task.status !== 'exited') ??
    tasks[0]
  return (
    <section className={styles.pane} aria-label={t('workbench.agentProcessesTitle')}>
      {(error || loadError) && (
        <p className={styles.error} role="alert">
          {error || loadError}
        </p>
      )}
      <div className={styles.body} data-empty={!selected}>
        {selected && (
          <nav className={styles.taskList} aria-label={t('workbench.agentProcessList')}>
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className={styles.taskItem}
                aria-pressed={task.id === selected.id}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <code title={task.command}>{task.command}</code>
                <span>
                  {t(`workbench.agentProcessStatus.${task.status}`)} · PID {task.pid}
                </span>
              </button>
            ))}
          </nav>
        )}
        <div className={styles.detail}>
          {selected ? (
            <>
              <header className={styles.taskHeader}>
                <div className={styles.taskHeading}>
                  <code title={selected.command}>{selected.command}</code>
                  <small title={selected.cwd}>{selected.cwd}</small>
                </div>
                {selected.status !== 'exited' && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(selected.id, 'stop')}
                    >
                      {t('workbench.agentProcessStop')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(selected.id, 'force')}
                    >
                      {t('workbench.agentProcessForceStop')}
                    </button>
                  </div>
                )}
              </header>
              <div className={styles.taskMeta}>
                <span>
                  {t(`workbench.agentProcessStatus.${selected.status}`)} · PID {selected.pid}
                </span>
                {selected.ports.length > 0 && <span>{selected.ports.join(', ')}</span>}
                {selected.exitCode != null && (
                  <span>{t('workbench.agentProcessExit', { code: selected.exitCode })}</span>
                )}
              </div>
              <ProcessOutput
                key={selected.id}
                text={selected.recentOutput || t('workbench.agentProcessNoOutput')}
                label={t('workbench.agentProcessOutput')}
                onOpenLink={onOpenLink}
              />
              {selected.console?.acceptsInput && selected.status !== 'exited' && (
                <form
                  className={styles.inputDock}
                  onSubmit={(event) => {
                    event.preventDefault()
                    void act(selected.id, 'input')
                  }}
                >
                  <TerminalWindowIcon size={14} />
                  <input
                    aria-label={t('workbench.agentProcessInput')}
                    placeholder={t('workbench.agentProcessInput')}
                    value={inputs[selected.id] ?? ''}
                    maxLength={16000}
                    disabled={busy}
                    spellCheck={false}
                    onChange={(event) =>
                      setInputs((current) => ({
                        ...current,
                        [selected.id]: event.target.value,
                      }))
                    }
                  />
                  <button type="submit" disabled={busy}>
                    {t('workbench.agentProcessSend')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(selected.id, 'interrupt')}
                  >
                    Ctrl+C
                  </button>
                </form>
              )}
            </>
          ) : (
            <p className={styles.empty}>{t('workbench.agentProcessesEmpty')}</p>
          )}
        </div>
      </div>
    </section>
  )
}
