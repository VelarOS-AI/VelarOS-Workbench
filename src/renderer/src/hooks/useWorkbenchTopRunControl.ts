import { useCallback, useMemo } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'

import { type SelectOption } from '@velaros-ai/ui/primitives/forms/Select'

import { useLatest } from '../support/genericHooks'

interface WorkbenchRunConfigurationLike {
  command: string
  label: string
}

interface WorkbenchCommandHistoryLike {
  command: string
}

export interface WorkbenchRunSessionLike {
  command?: string
  id: string
  isRunning: boolean
}

interface UseWorkbenchTopRunControlOptions {
  commandHistory: WorkbenchCommandHistoryLike[]
  runConfigurations: WorkbenchRunConfigurationLike[]
  runningSessions: WorkbenchRunSessionLike[]
  /** 用户为当前项目手动配置的启动命令；为空则回退到自动探测。 */
  configuredCommand: string
  /** 最近一次运行过的命令（含从编辑器 gutter ▶ 触发的）；进入列表并作为默认项。 */
  lastLaunchedCommand: string
  /** 启动一张新运行卡（WebStorm 式，每次新开）。 */
  onLaunchCommand: (command: string, label?: string) => void
  /** 就地停止并重启一张已运行的卡。 */
  onRestartRunSession: (sessionId: string) => void
  /** 持久化启动命令；传入空串即清除配置，回退到自动探测。 */
  onConfigureCommand: (command: string) => void
}

export interface WorkbenchTopRunControl {
  activeCommand: string
  options: Array<SelectOption<string>>
  /** 当前生效的命令是否来自用户手动配置（而非自动探测）。 */
  isConfigured: boolean
  configuredCommand: string
  /** 当前生效命令是否已有一张正在执行的运行卡。 */
  isActiveCommandRunning: boolean
  /** 始终新开一张运行卡。 */
  run: () => void
  /** 停止并重新运行当前生效命令最近的一张运行卡。 */
  restartActiveCommand: () => void
  /** 保存/覆盖手动配置的启动命令；空串清除回退自动探测。 */
  configureCommand: (command: string) => void
}

/** 判断命令是否像“启动/运行”命令（dev/serve/start），用于未配置时挑默认项。 */
function isLaunchCommand(text: string): boolean {
  return /\b(dev|serve|start)\b/i.test(text)
}

export function findLastRunningWorkbenchRunSession(
  activeCommand: string,
  sessions: readonly WorkbenchRunSessionLike[]
): WorkbenchRunSessionLike | undefined {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]
    if (session?.isRunning && session.command === activeCommand) return session
  }
  return undefined
}

export function useWorkbenchTopRunControl({
  commandHistory,
  runConfigurations,
  runningSessions,
  configuredCommand,
  lastLaunchedCommand,
  onLaunchCommand,
  onRestartRunSession,
  onConfigureCommand,
}: UseWorkbenchTopRunControlOptions): WorkbenchTopRunControl {
  const { t } = useWorkbenchI18n()
  const onLaunchCommandLatest = useLatest(onLaunchCommand)
  const onRestartRunSessionLatest = useLatest(onRestartRunSession)
  const onConfigureCommandLatest = useLatest(onConfigureCommand)
  const normalizedConfiguredCommand = configuredCommand.trim()
  const normalizedLastLaunched = lastLaunchedCommand.trim()

  const options = useMemo<Array<SelectOption<string>>>(() => {
    const nextOptions = new Map<string, SelectOption<string>>()
    if (normalizedConfiguredCommand) {
      nextOptions.set(normalizedConfiguredCommand, {
        value: normalizedConfiguredCommand,
        label: normalizedConfiguredCommand,
        description: t('workbench.runConfiguredCommand'),
      })
    }
    // 最近运行过的命令进入列表（gutter ▶ 触发的也算），便于右键切换。
    if (normalizedLastLaunched && !nextOptions.has(normalizedLastLaunched)) {
      nextOptions.set(normalizedLastLaunched, {
        value: normalizedLastLaunched,
        label: normalizedLastLaunched,
        description: t('workbench.recentCommands'),
      })
    }
    runConfigurations.forEach((configuration) => {
      if (nextOptions.has(configuration.command)) return
      nextOptions.set(configuration.command, {
        value: configuration.command,
        label: configuration.label,
        description: configuration.command,
      })
    })
    commandHistory.slice(0, 4).forEach((item) => {
      if (!nextOptions.has(item.command)) {
        nextOptions.set(item.command, {
          value: item.command,
          label: item.command,
          description: t('workbench.recentCommands'),
        })
      }
    })
    return [...nextOptions.values()]
  }, [commandHistory, normalizedConfiguredCommand, normalizedLastLaunched, runConfigurations, t])

  // 生效命令：优先用户手动配置，否则自动挑一个“启动”类命令，再退回第一项。
  const autoCommand = useMemo(() => {
    const launchOption = options.find((option) => isLaunchCommand(`${option.label} ${option.value}`))
    return launchOption?.value ?? options[0]?.value ?? ''
  }, [options])
  // 优先级：手动配置 > 最近运行 > 自动探测。让侧边栏 ▶ 记住上次跑过的命令。
  const activeCommand = normalizedConfiguredCommand || normalizedLastLaunched || autoCommand
  const activeLabel = useMemo(
    () => options.find((option) => option.value === activeCommand)?.label,
    [activeCommand, options]
  )
  const activeCommandRunningSession = useMemo(
    () => findLastRunningWorkbenchRunSession(activeCommand, runningSessions),
    [activeCommand, runningSessions]
  )

  const run = useCallback((): void => {
    if (!activeCommand) return

    onLaunchCommandLatest.current(activeCommand, activeLabel)
  }, [activeCommand, activeLabel])

  const restartActiveCommand = useCallback((): void => {
    if (activeCommandRunningSession) {
      onRestartRunSessionLatest.current(activeCommandRunningSession.id)
    }
  }, [activeCommandRunningSession])

  const configureCommand = useCallback((command: string): void => {
    onConfigureCommandLatest.current(command.trim())
  }, [])

  return {
    activeCommand,
    options,
    isConfigured: !!normalizedConfiguredCommand,
    configuredCommand: normalizedConfiguredCommand,
    isActiveCommandRunning: !!activeCommandRunningSession,
    run,
    restartActiveCommand,
    configureCommand,
  }
}
