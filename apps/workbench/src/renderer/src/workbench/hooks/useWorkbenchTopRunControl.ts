import { useCallback, useMemo } from 'react'
import { useWorkbenchI18n } from '@workbench/i18n'

import { type SelectOption } from '@velaros-ai/ui/primitives/forms/Select'

import { useLatest } from '../support/genericHooks'

interface WorkbenchRunConfigurationLike {
  command: string
  label: string
}

interface WorkbenchCommandHistoryLike {
  command: string
}

interface UseWorkbenchTopRunControlOptions {
  commandHistory: WorkbenchCommandHistoryLike[]
  runConfigurations: WorkbenchRunConfigurationLike[]
  /** 用户为当前项目手动配置的启动命令；为空则回退到自动探测。 */
  configuredCommand: string
  /** 最近一次运行过的命令（含从编辑器 gutter ▶ 触发的）；进入列表并作为默认项。 */
  lastLaunchedCommand: string
  /** 当前激活的运行卡是否正在运行；决定按钮是「运行」还是「终止」。 */
  isActiveRunning: boolean
  onOpenRunTool: () => void
  /** 启动一张新运行卡（WebStorm 式，每次新开）。 */
  onLaunchCommand: (command: string, label?: string) => void
  /** 终止当前激活的运行卡。 */
  onStopActiveRun: () => void
  /** 持久化启动命令；传入空串即清除配置，回退到自动探测。 */
  onConfigureCommand: (command: string) => void
}

export interface WorkbenchTopRunControl {
  activeCommand: string
  options: Array<SelectOption<string>>
  /** 当前生效的命令是否来自用户手动配置（而非自动探测）。 */
  isConfigured: boolean
  configuredCommand: string
  /** 当前激活运行卡是否运行中（按钮据此在「运行/终止」间切换）。 */
  isActiveRunning: boolean
  /** 运行中 → 终止激活卡；否则 → 新开一张运行卡。 */
  run: () => void
  /** 保存/覆盖手动配置的启动命令；空串清除回退自动探测。 */
  configureCommand: (command: string) => void
}

/** 判断命令是否像“启动/运行”命令（dev/serve/start），用于未配置时挑默认项。 */
function isLaunchCommand(text: string): boolean {
  return /\b(dev|serve|start)\b/i.test(text)
}

export function useWorkbenchTopRunControl({
  commandHistory,
  runConfigurations,
  configuredCommand,
  lastLaunchedCommand,
  isActiveRunning,
  onOpenRunTool,
  onLaunchCommand,
  onStopActiveRun,
  onConfigureCommand,
}: UseWorkbenchTopRunControlOptions): WorkbenchTopRunControl {
  const { t } = useWorkbenchI18n()
  const onOpenRunToolLatest = useLatest(onOpenRunTool)
  const onLaunchCommandLatest = useLatest(onLaunchCommand)
  const onStopActiveRunLatest = useLatest(onStopActiveRun)
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
    runConfigurations.slice(0, 10).forEach((configuration) => {
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

  const run = useCallback((): void => {
    // 运行中 → 终止当前激活运行卡；否则 → 新开一张运行卡。
    if (isActiveRunning) {
      onStopActiveRunLatest.current()
      return
    }

    if (!activeCommand) return

    onOpenRunToolLatest.current()
    onLaunchCommandLatest.current(activeCommand, activeLabel)
  }, [activeCommand, activeLabel, isActiveRunning])

  const configureCommand = useCallback((command: string): void => {
    onConfigureCommandLatest.current(command.trim())
  }, [])

  return {
    activeCommand,
    options,
    isConfigured: !!normalizedConfiguredCommand,
    configuredCommand: normalizedConfiguredCommand,
    isActiveRunning,
    run,
    configureCommand,
  }
}
