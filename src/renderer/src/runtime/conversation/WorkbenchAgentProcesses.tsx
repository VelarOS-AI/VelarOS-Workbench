import { type ReactElement, useEffect, useState } from 'react'
import { TerminalWindowIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'

import { AppError } from '@velaros-ai/core/error'
import { Popover, PopoverAnchor, PopoverContent } from '@velaros-ai/ui/primitives/overlays/Popover'
import type { ShellBackgroundTaskRecord } from '@velaros-ai/velaros/execution/contracts'

import type { WorkbenchConversationSessionRequest } from '@shared/workbenchConversation'

import styles from './WorkbenchAgentProcesses.module.css'

/** 开发服务器和交互式命令跨回合保留；打开面板时持续刷新输出。 */
export function WorkbenchAgentProcesses({
  projectRoot,
  sessionId,
}: WorkbenchConversationSessionRequest): ReactElement {
  const { t } = useWorkbenchI18n()
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<readonly ShellBackgroundTaskRecord[]>([])
  const [loadError, setLoadError] = useState<Nullable<string>>(null)
  const [error, setError] = useState<Nullable<string>>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const scope = `${projectRoot}\0${sessionId}`
  useEffect(() => {
    setTasks([])
    setLoadError(null)
    setInputs({})
    setError(null)
    setBusy(false)
  }, [scope])
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
    const timer = open ? setInterval(() => void load(), 1000) : undefined
    return () => {
      disposed = true
      off()
      clearInterval(timer)
    }
  }, [projectRoot, sessionId, open, revision])

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
  const running = tasks.filter((task) => task.status !== 'exited').length
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className={styles.trigger}
          title={t('workbench.agentProcessesTitle')}
          aria-label={t('workbench.agentProcessesTitle')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <TerminalWindowIcon size={16} />
          {running > 0 && <span>{running}</span>}
        </button>
      </PopoverAnchor>
      <PopoverContent align="end" side="bottom" widthStrategy="content" className={styles.popover}>
        <section className={styles.panel} aria-label={t('workbench.agentProcessesTitle')}>
          <strong>{t('workbench.agentProcessesTitle')}</strong>
          <p>{t('workbench.agentProcessesDescription')}</p>
          {(error || loadError) && <p role="alert">{error || loadError}</p>}
          <div className={styles.list}>
            {tasks.length === 0 && <p>{t('workbench.agentProcessesEmpty')}</p>}
            {tasks.map((task) => (
              <article key={task.id} className={styles.task}>
                <header>
                  <strong>{t(`workbench.agentProcessStatus.${task.status}`)}</strong>
                  <span>
                    PID {task.pid}
                    {task.ports.length ? ` · ${task.ports.join(', ')}` : ''}
                    {task.exitCode != null
                      ? ` · ${t('workbench.agentProcessExit', { code: task.exitCode })}`
                      : ''}
                  </span>
                </header>
                <code>{task.command}</code>
                <small>{task.cwd}</small>
                <pre aria-label={t('workbench.agentProcessOutput')}>
                  {task.recentOutput || t('workbench.agentProcessNoOutput')}
                </pre>
                {task.console?.acceptsInput && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      void act(task.id, 'input')
                    }}
                  >
                    <input
                      aria-label={t('workbench.agentProcessInput')}
                      value={inputs[task.id] ?? ''}
                      maxLength={16000}
                      disabled={busy}
                      onChange={(event) =>
                        setInputs((current) => ({ ...current, [task.id]: event.target.value }))
                      }
                    />
                    <button type="submit" disabled={busy}>
                      {t('workbench.agentProcessSend')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(task.id, 'interrupt')}
                    >
                      Ctrl+C
                    </button>
                  </form>
                )}
                {task.status !== 'exited' && (
                  <div className={styles.actions}>
                    <button type="button" disabled={busy} onClick={() => void act(task.id, 'stop')}>
                      {t('workbench.agentProcessStop')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(task.id, 'force')}
                    >
                      {t('workbench.agentProcessForceStop')}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </PopoverContent>
    </Popover>
  )
}
