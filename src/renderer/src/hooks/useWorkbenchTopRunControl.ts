import { useCallback, useMemo } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchRunSessionLaunchOptions } from '@renderer/models/commands/workbenchCommandLines'
import {
  buildWorkbenchRunConfigurationLaunch,
  type WorkbenchNamedRunConfiguration,
} from '@renderer/models/commands/workbenchNamedRunConfigurations'

import { toNullable } from '@velaros-ai/core'
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
  launch?: Pick<WorkbenchRunSessionLaunchOptions, 'configurationId'>
}

interface UseWorkbenchTopRunControlOptions {
  commandHistory: WorkbenchCommandHistoryLike[]
  runConfigurations: WorkbenchRunConfigurationLike[]
  /** 用户建的运行配置：菜单里排在最前面。 */
  namedConfigurations: readonly WorkbenchNamedRunConfiguration[]
  runningSessions: WorkbenchRunSessionLike[]
  /** 用户为当前项目手动配置的启动命令；为空则回退到自动探测。 */
  configuredCommand: string
  /** ▶ 指着的运行配置的 id；没指着、或那份配置已经删了，就看启动命令。 */
  configuredConfigurationId: string
  /** 最近一次运行过的命令（含从编辑器 gutter ▶ 触发的）；进入列表并作为默认项。 */
  lastLaunchedCommand: string
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
  /** 把 ▶ 指到一份运行配置上。 */
  onSelectConfiguration: (configurationId: string) => void
  /** 打开「编辑运行配置」对话框。 */
  onEditConfigurations: () => void
}

export interface WorkbenchTopRunControl {
  activeCommand: string
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
  /** 把 ▶ 指到一份运行配置上（记在项目设置里）。 */
  selectConfiguration: (configurationId: string) => void
  /** 直接跑一份运行配置，▶ 指着什么不变。 */
  runConfiguration: (configurationId: string) => void
  /** 打开「编辑运行配置」对话框。 */
  editConfigurations: () => void
}

/** 判断命令是否像“启动/运行”命令（dev/serve/start），用于未配置时挑默认项。 */
function isLaunchCommand(text: string): boolean {
  return /\b(dev|serve|start)\b/i.test(text)
}

/**
 * 这条命令（或这份运行配置）最近一张还在跑的运行卡。给了 `configurationId` 就只认这份配置起的卡；不给则只认
 * 直接跑命令起的——同一条命令换了目录、变量是另一回事，不能互相顶替。
 */
export function findLastRunningWorkbenchRunSession(
  activeCommand: string,
  sessions: readonly WorkbenchRunSessionLike[],
  configurationId?: string
): WorkbenchRunSessionLike | undefined {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]
    if (!session?.isRunning) continue

    const matches = configurationId
      ? session.launch?.configurationId === configurationId
      : session.command === activeCommand && !session.launch?.configurationId
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
  configuredConfigurationId,
  lastLaunchedCommand,
  onLaunchCommand,
  onRestartRunSession,
  onConfigureCommand,
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
  const normalizedConfiguredCommand = configuredCommand.trim()
  const normalizedLastLaunched = lastLaunchedCommand.trim()
  const activeConfiguration = useMemo(
    () =>
      toNullable(
        namedConfigurations.find((configuration) => configuration.id === configuredConfigurationId)
      ),
    [configuredConfigurationId, namedConfigurations]
  )

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
  // 优先级：指着的运行配置 > 手动配置 > 最近运行 > 自动探测。让侧边栏 ▶ 记住上次跑过的命令。
  const activeCommand =
    activeConfiguration?.command || normalizedConfiguredCommand || normalizedLastLaunched || autoCommand
  const activeLabel = useMemo(
    () => options.find((option) => option.value === activeCommand)?.label,
    [activeCommand, options]
  )
  const activeCommandRunningSession = useMemo(
    () => findLastRunningWorkbenchRunSession(activeCommand, runningSessions, activeConfiguration?.id),
    [activeCommand, activeConfiguration?.id, runningSessions]
  )

  const launchConfiguration = useCallback((configuration: WorkbenchNamedRunConfiguration): void => {
    onLaunchCommandLatest.current(
      configuration.command,
      configuration.name,
      buildWorkbenchRunConfigurationLaunch(configuration)
    )
  }, [])

  const run = useCallback((): void => {
    if (activeConfiguration) {
      launchConfiguration(activeConfiguration)
      return
    }
    if (!activeCommand) return

    onLaunchCommandLatest.current(activeCommand, activeLabel)
  }, [activeCommand, activeConfiguration, activeLabel, launchConfiguration])

  const restartActiveCommand = useCallback((): void => {
    if (activeCommandRunningSession) {
      onRestartRunSessionLatest.current(activeCommandRunningSession.id)
    }
  }, [activeCommandRunningSession])

  const configureCommand = useCallback((command: string): void => {
    onConfigureCommandLatest.current(command.trim())
  }, [])

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

  const editConfigurations = useCallback((): void => {
    onEditConfigurationsLatest.current()
  }, [])

  return {
    activeCommand,
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
    selectConfiguration,
    runConfiguration,
    editConfigurations,
  }
}
