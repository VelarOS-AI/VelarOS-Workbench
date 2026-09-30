/**
 * 用户自己建的运行配置：起个名字，写好命令、工作目录和环境变量，排在 ▶ 菜单最前面，跑起来是一张普通的运行卡。
 *
 * 按项目存在应用自己的存储里（与命令历史同一种，不往用户的仓库里写文件）。读出来的每一项都重新校验：
 * 认不出的项丢掉，工作目录不在项目里的退回项目根，环境变量不合规的整表清空——存储里的东西可能来自更早的版本
 * 或者被手改过，不能原样信。
 *
 * 这个模块在工作区外壳包里（▶ 要读配置、跑配置），只放读写与运行用得到的；对话框里编辑草稿的那部分在
 * `workbenchRunConfigurationDrafts.ts`，随对话框按需加载。
 */
import { isArray, isString, Log } from '@velaros-ai/core'
import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  readWorkbenchRunEnvironment,
  type WorkbenchRunEnvironment,
} from '@shared/workbenchRunEnvironment'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

import type { WorkbenchRunSessionLaunchOptions } from './workbenchCommandLines'

export interface WorkbenchNamedRunConfiguration {
  id: string
  name: string
  /** 在 shell 里执行的命令。 */
  command: string
  /** 工作目录：项目里的相对路径（`/` 分隔），空串是项目根。 */
  cwd: string
  /** 环境变量，盖在终端环境之上。 */
  env: WorkbenchRunEnvironment
}

export const WORKBENCH_RUN_CONFIGURATIONS_CHANGED_EVENT =
  'velaros:workbench-run-configurations-changed'
export const RUN_CONFIGURATIONS_STORAGE_KEY = 'velaros.workbench.run-configurations.v1'
export const WorkbenchRunConfigurationNameMaxLength = 80

const MaxConfigurationsPerProject = 50
const MaxIdLength = 120
const MaxCommandLength = 8_000
const MaxCwdLength = 1_000
const log = Log.tag('workbench-run-configurations')

/**
 * 工作目录收成项目里的相对路径：分隔符统一成 `/`，去掉开头的 `./` 和结尾的 `/`；`.`、空白都是项目根（空串）。
 * 绝对路径、带 `..` 的路径不在项目里，返回 null。真去起进程时主进程还会按真实路径再查一遍。
 */
export function normalizeWorkbenchRunConfigurationCwd(input: string): Nullable<string> {
  const normalized = input.trim().replace(/\\/gu, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return null

  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (segments.includes('..')) return null
  const cwd = segments.join('/')
  return cwd.length > MaxCwdLength ? null : cwd
}

/** 把一份外来的数据读成配置；缺名称、缺命令、缺 id（或者长得离谱）的不算数，返回 null。 */
export function normalizeWorkbenchNamedRunConfiguration(
  value: unknown
): Nullable<WorkbenchNamedRunConfiguration> {
  if (!isRecord(value)) return null

  const id = isString(value.id) ? value.id.trim() : ''
  const name = isString(value.name) ? value.name.trim() : ''
  const command = isString(value.command) ? value.command.trim() : ''
  if (!id || id.length > MaxIdLength) return null
  if (!name || name.length > WorkbenchRunConfigurationNameMaxLength) return null
  if (!command || command.length > MaxCommandLength) return null

  return {
    id,
    name,
    command,
    cwd: (isString(value.cwd) ? normalizeWorkbenchRunConfigurationCwd(value.cwd) : null) ?? '',
    env: readWorkbenchRunEnvironment(value.env) ?? {},
  }
}

function normalizeConfigurationList(value: unknown): WorkbenchNamedRunConfiguration[] {
  if (!isArray(value)) return []

  const seenIds = new Set<string>()
  const configurations: WorkbenchNamedRunConfiguration[] = []
  for (const item of value) {
    const configuration = normalizeWorkbenchNamedRunConfiguration(item)
    if (!configuration || seenIds.has(configuration.id)) continue

    seenIds.add(configuration.id)
    configurations.push(configuration)
    if (configurations.length >= MaxConfigurationsPerProject) break
  }
  return configurations
}

function normalizeConfigurationMap(
  value: unknown
): Record<string, WorkbenchNamedRunConfiguration[]> {
  if (!isRecord(value)) return {}

  const result: Record<string, WorkbenchNamedRunConfiguration[]> = {}
  for (const [projectId, list] of Object.entries(value)) {
    const configurations = normalizeConfigurationList(list)
    if (configurations.length > 0) result[projectId] = configurations
  }
  return result
}

const workbenchRunConfigurationStore = createLocalStorageJsonStore<
  Record<string, WorkbenchNamedRunConfiguration[]>
>({
  key: RUN_CONFIGURATIONS_STORAGE_KEY,
  fallback: () => ({}),
  normalize: normalizeConfigurationMap,
  log,
  readErrorMessage: '读取 workbench 运行配置失败，当作没有配置',
  writeErrorMessage: '写入 workbench 运行配置失败',
})

export function readWorkbenchNamedRunConfigurations(
  projectId: LooseOptional<string>,
  storage?: StorageLike
): WorkbenchNamedRunConfiguration[] {
  if (!projectId) return []

  return workbenchRunConfigurationStore.read(storage)[projectId] ?? []
}

/** 存下这个项目的全部配置（整份换掉），并通知同一窗口里用着它们的地方。 */
export function saveWorkbenchNamedRunConfigurations(
  projectId: string,
  configurations: readonly WorkbenchNamedRunConfiguration[],
  storage?: StorageLike,
  target: LooseOptional<Pick<Window, 'dispatchEvent'>> = globalThis.window
): WorkbenchNamedRunConfiguration[] {
  const normalized = normalizeConfigurationList(configurations)
  const map = workbenchRunConfigurationStore.read(storage)
  if (normalized.length > 0) map[projectId] = normalized
  else delete map[projectId]
  workbenchRunConfigurationStore.write(map, storage)
  target?.dispatchEvent(
    new CustomEvent(WORKBENCH_RUN_CONFIGURATIONS_CHANGED_EVENT, { detail: { projectId } })
  )
  return normalized
}

/** 菜单里名字下面的那行小字：命令，不在项目根跑的再带上目录。 */
export function describeWorkbenchRunConfiguration(
  configuration: WorkbenchNamedRunConfiguration
): string {
  return configuration.cwd
    ? `${configuration.command} · ${configuration.cwd}`
    : configuration.command
}

/** 跑这份配置时命令之外要交给运行卡的：出自哪份配置，加上它的工作目录、环境变量（没有的不给）。 */
export function buildWorkbenchRunConfigurationLaunch(
  configuration: WorkbenchNamedRunConfiguration
): WorkbenchRunSessionLaunchOptions {
  const launch: WorkbenchRunSessionLaunchOptions = { configurationId: configuration.id }
  if (configuration.cwd) launch.cwd = configuration.cwd
  if (Object.keys(configuration.env).length > 0) launch.env = configuration.env
  return launch
}
