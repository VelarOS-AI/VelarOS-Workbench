import { useCallback, useMemo } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import {
  type WorkbenchRunCommand,
  workbenchRunCommandKey,
  type WorkbenchRunSessionLaunchOptions,
} from '@renderer/models/commands/workbenchCommandLines'
import {
  buildWorkbenchRunConfigurationCommand,
  buildWorkbenchRunConfigurationLaunch,
  type WorkbenchNamedRunConfiguration,
} from '@renderer/models/commands/workbenchNamedRunConfigurations'

import { type SelectOption } from '@velaros-ai/ui/primitives/forms/Select'
import { toNullable } from '@velaros-ai/velaros/core'

import { useLatest } from '../support/genericHooks'

interface WorkbenchRunConfigurationLike extends WorkbenchRunCommand {
  label: string
}

interface WorkbenchCommandHistoryLike {
  command: string
}

export interface WorkbenchRunSessionLike {
  command?: string
  id: string
  isRunning: boolean
  launch?: WorkbenchRunSessionLaunchOptions
}

interface UseWorkbenchTopRunControlOptions {
  commandHistory: WorkbenchCommandHistoryLike[]
  runConfigurations: WorkbenchRunConfigurationLike[]
  /** 用户建的运行配置：菜单里排在最前面。 */
  namedConfigurations: readonly WorkbenchNamedRunConfiguration[]
  runningSessions: WorkbenchRunSessionLike[]
  /** 用户为当前项目手动配置的启动命令；为空则回退到自动探测。 */
  configuredCommand: string
  configuredLaunch?: WorkbenchRunSessionLaunchOptions
  /** ▶ 指着的运行配置的 id；没指着、或那份配置已经删了，就看启动命令。 */
  configuredConfigurationId: string
  /** 最近一次运行过的命令（含从编辑器 gutter ▶ 触发的）；进入列表并作为默认项。 */
  lastLaunchedRun: Nullable<WorkbenchRunCommand>
  /** 启动一张新运行卡（WebStorm 式，每次新开）。 */
  onLaunchCommand: (
    command: string,
    label?: string,
    launch?: WorkbenchRunSessionLaunchOptions
  ) => void
  /** 就地停止并重启一张已运行的卡。 */
  onRestartRunSession: (sessionId: string) => void
  /** 持久化启动命令；传入空串即清除配置，回退到自动探测。 */
  onConfigureCommand: (command: string) => void
  onSelectRunCommand: (command: WorkbenchRunCommand) => void
  /** 把 ▶ 指到一份运行配置上。 */
  onSelectConfiguration: (configurationId: string) => void
  /** 打开「编辑运行配置」对话框。 */
  onEditConfigurations: () => void
}

export interface WorkbenchTopRunControl {
  activeCommand: string
  activeCommandKey: string
  options: Array<SelectOption<string>>
  /** 当前生效的命令是否来自用户手动配置（而非自动探测）。 */
  isConfigured: boolean
  configuredCommand: string
  /** 当前生效命令是否已有一张正在执行的运行卡。 */
  isActiveCommandRunning: boolean
  /** 用户建的运行配置，菜单里排在最前面。 */
  namedConfigurations: readonly WorkbenchNamedRunConfiguration[]
  /** ▶ 此刻指着的运行配置；指着的是一条普通命令时为 null。 */
  activeConfiguration: Nullable<WorkbenchNamedRunConfiguration>
  /** 始终新开一张运行卡。 */
  run: () => void
  /** 停止并重新运行当前生效命令最近的一张运行卡。 */
  restartActiveCommand: () => void
  /** 保存/覆盖手动配置的启动命令；空串清除回退自动探测。 */
  configureCommand: (command: string) => void
  /** 选择已知菜单项，保存它的真实启动目标；不把显示文本重解释成 shell。 */
  selectCommand: (key: string) => void
  /** 把 ▶ 指到一份运行配置上（记在项目设置里）。 */
  selectConfiguration: (configurationId: string) => void
  /** 直接跑一份运行配置，▶ 指着什么不变。 */
  runConfiguration: (configurationId: string) => void
  /** ▶ 指着的是一个 Node 程序：旁边多一个「调试」。 */
  canDebugActiveConfiguration: boolean
  /** 调试 ▶ 指着的那份配置；它已经有一张调试卡在跑，就地重新开始。 */
  debug: () => void
  /** 调试一份运行配置（Node 程序），▶ 指着什么不变。 */
  debugConfiguration: (configurationId: string) => void
  /** 打开「编辑运行配置」对话框。 */
  editConfigurations: () => void
}

/** 判断命令是否像“启动/运行”命令（dev/serve/start），用于未配置时挑默认项。 */
function isLaunchCommand(text: string): boolean {
  return /\b(dev|serve|start)\b/i.test(text)
}

/**
 * 这条命令（或这份运行配置）最近一张还在跑的运行卡。给了 `configurationId` 就只认这份配置起的卡；不给则只认
 * 直接跑命令起的——同一条命令换了目录、变量是另一回事，不能互相顶替。运行与调试也分开认：`debug` 为真只找
 * 调试卡，否则只找普通的运行卡。
 */
export function findLastRunningWorkbenchRunSession(
  activeCommand: string,
  sessions: readonly WorkbenchRunSessionLike[],
  configurationId?: string,
  debug = false,
  launch?: WorkbenchRunSessionLaunchOptions
): WorkbenchRunSessionLike | undefined {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]
    if (!session?.isRunning || !!session.launch?.debug !== debug) continue

    const matches = configurationId
      ? session.launch?.configurationId === configurationId
      : !session.launch?.configurationId &&
        workbenchRunCommandKey(session.command ?? '', session.launch) ===
          workbenchRunCommandKey(activeCommand, launch)
    if (matches) return session
  }
  return undefined
}

export function useWorkbenchTopRunControl({
  commandHistory,
  runConfigurations,
  namedConfigurations,
  runningSessions,
  configuredCommand,
  configuredLaunch,
  configuredConfigurationId,
  lastLaunchedRun,
  onLaunchCommand,
  onRestartRunSession,
  onConfigureCommand,
  onSelectRunCommand,
  onSelectConfiguration,
  onEditConfigurations,
}: UseWorkbenchTopRunControlOptions): WorkbenchTopRunControl {
  const { t } = useWorkbenchI18n()
  const onLaunchCommandLatest = useLatest(onLaunchCommand)
  const onRestartRunSessionLatest = useLatest(onRestartRunSession)
  const onConfigureCommandLatest = useLatest(onConfigureCommand)
  const onSelectConfigurationLatest = useLatest(onSelectConfiguration)
  const onEditConfigurationsLatest = useLatest(onEditConfigurations)
  const namedConfigurationsLatest = useLatest(namedConfigurations)
  const runningSessionsLatest = useLatest(runningSessions)
  const normalizedConfiguredCommand = configuredCommand.trim()
  const activeConfiguration = useMemo(
    () =>
      toNullable(
        namedConfigurations.find((configuration) => configuration.id === configuredConfigurationId)
      ),
    [configuredConfigurationId, namedConfigurations]
  )

  const configuredRun = useMemo<Nullable<WorkbenchRunCommand>>(
    () => normalizedConfiguredCommand
      ? { command: normalizedConfiguredCommand, launch: configuredLaunch }
      : null,
    [configuredLaunch, normalizedConfiguredCommand]
  )
  const options = useMemo<Array<SelectOption<string> & { run: WorkbenchRunCommand }>>(() => {
    const nextOptions = new Map<string, SelectOption<string> & { run: WorkbenchRunCommand }>()
    const add = (run: WorkbenchRunCommand, description: string): void => {
      const key = workbenchRunCommandKey(run.command, run.launch)
      if (nextOptions.has(key)) return
      nextOptions.set(key, { value: key, label: run.label || run.command, description, run })
    }
    if (normalizedConfiguredCommand) {
      add(
        { command: normalizedConfiguredCommand, launch: configuredLaunch },
        t('workbench.runConfiguredCommand')
      )
    }
    // 最近运行过的命令进入列表（gutter ▶ 触发的也算），便于右键切换。
    if (lastLaunchedRun) add(lastLaunchedRun, t('workbench.recentCommands'))
    runConfigurations.forEach((configuration) => {
      add(configuration, configuration.command)
    })
    commandHistory.slice(0, 4).forEach((item) => {
      add({ command: item.command }, t('workbench.recentCommands'))
    })
    return [...nextOptions.values()]
  }, [commandHistory, configuredLaunch, lastLaunchedRun, normalizedConfiguredCommand, runConfigurations, t])

  // 生效命令：优先用户手动配置，否则自动挑一个“启动”类命令，再退回第一项。
  const autoRun = useMemo(() => {
    const launchOption = options.find((option) =>
      isLaunchCommand(`${option.label} ${option.run.command}`)
    )
    return launchOption?.run ?? options[0]?.run ?? null
  }, [options])
  // 优先级：指着的运行配置 > 手动配置 > 最近运行 > 自动探测。让侧边栏 ▶ 记住上次跑过的命令。
  const activeConfigurationCommand = useMemo(
    () => (activeConfiguration ? buildWorkbenchRunConfigurationCommand(activeConfiguration) : ''),
    [activeConfiguration]
  )
  const activeRun = configuredRun ?? lastLaunchedRun ?? autoRun
  const activeCommand = activeConfigurationCommand || activeRun?.command || ''
  const activeCommandKey = activeRun ? workbenchRunCommandKey(activeRun.command, activeRun.launch) : ''
  const activeLabel = useMemo(
    () => options.find((option) => option.value === activeCommandKey)?.label,
    [activeCommandKey, options]
  )
  const activeCommandRunningSession = useMemo(
    () =>
      findLastRunningWorkbenchRunSession(
        activeCommand, runningSessions, activeConfiguration?.id, false, activeRun?.launch
      ),
    [activeCommand, activeConfiguration?.id, activeRun?.launch, runningSessions]
  )

  const launchConfiguration = useCallback(
    (configuration: WorkbenchNamedRunConfiguration, debug = false): void => {
      onLaunchCommandLatest.current(
        buildWorkbenchRunConfigurationCommand(configuration),
        debug
          ? t('workbench.debuggerRunCardTitle', { name: configuration.name })
          : configuration.name,
        buildWorkbenchRunConfigurationLaunch(configuration, debug)
      )
    },
    [t]
  )

  const run = useCallback((): void => {
    if (activeConfiguration) {
      launchConfiguration(activeConfiguration)
      return
    }
    if (!activeCommand) return

    onLaunchCommandLatest.current(activeCommand, activeLabel, activeRun?.launch)
  }, [activeCommand, activeConfiguration, activeLabel, activeRun?.launch, launchConfiguration])

  const restartActiveCommand = useCallback((): void => {
    if (activeCommandRunningSession) {
      onRestartRunSessionLatest.current(activeCommandRunningSession.id)
    }
  }, [activeCommandRunningSession])

  const configureCommand = useCallback((command: string): void => {
    onConfigureCommandLatest.current(command.trim())
  }, [])

  const selectCommand = useCallback((key: string): void => {
    const option = options.find((candidate) => candidate.value === key)
    if (option) onSelectRunCommand(option.run)
  }, [onSelectRunCommand, options])

  const selectConfiguration = useCallback((configurationId: string): void => {
    onSelectConfigurationLatest.current(configurationId)
  }, [])

  const runConfiguration = useCallback(
    (configurationId: string): void => {
      const configuration = namedConfigurationsLatest.current.find(
        (candidate) => candidate.id === configurationId
      )
      if (configuration) launchConfiguration(configuration)
    },
    [launchConfiguration]
  )

  const debugConfiguration = useCallback(
    (configurationId: string): void => {
      const configuration = namedConfigurationsLatest.current.find(
        (candidate) => candidate.id === configurationId
      )
      if (configuration?.type !== 'node') return

      // 这份配置已经有一张调试卡在跑：就地重新开始，不另开一张。
      const running = findLastRunningWorkbenchRunSession(
        '',
        runningSessionsLatest.current,
        configuration.id,
        true
      )
      if (running) onRestartRunSessionLatest.current(running.id)
      else launchConfiguration(configuration, true)
    },
    [launchConfiguration]
  )

  const debug = useCallback((): void => {
    if (activeConfiguration) debugConfiguration(activeConfiguration.id)
  }, [activeConfiguration, debugConfiguration])

  const editConfigurations = useCallback((): void => {
    onEditConfigurationsLatest.current()
  }, [])

  return {
    activeCommand,
    activeCommandKey,
    options,
    // 指着一份运行配置时，「手动配置的命令」这一栏不算生效。
    isConfigured: !activeConfiguration && !!normalizedConfiguredCommand,
    configuredCommand: normalizedConfiguredCommand,
    isActiveCommandRunning: !!activeCommandRunningSession,
    namedConfigurations,
    activeConfiguration,
    run,
    restartActiveCommand,
    configureCommand,
    selectCommand,
    selectConfiguration,
    runConfiguration,
    canDebugActiveConfiguration: activeConfiguration?.type === 'node',
    debug,
    debugConfiguration,
    editConfigurations,
  }
}
