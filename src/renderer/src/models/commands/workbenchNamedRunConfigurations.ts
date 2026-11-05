/**
 * 用户自己建的运行配置：起个名字，写好命令、工作目录和环境变量，排在 ▶ 菜单最前面，跑起来是一张普通的运行卡。
 * 两种：一条 shell 命令；或者一个 Node.js 程序（脚本 + 参数），后者除了运行还能调试。
 *
 * 按项目存在应用自己的存储里（与命令历史同一种，不往用户的仓库里写文件）。读出来的每一项都重新校验：
 * 认不出的项丢掉，工作目录不在项目里的退回项目根，环境变量不合规的整表清空——存储里的东西可能来自更早的版本
 * 或者被手改过，不能原样信。
 *
 * 这个模块在工作区外壳包里（▶ 要读配置、跑配置），只放读写与运行用得到的；对话框里编辑草稿的那部分在
 * `workbenchRunConfigurationDrafts.ts`，随对话框按需加载。
 */
import { isArray, isString, Log } from '@velaros-ai/velaros/core'
import { isRecord } from '@velaros-ai/velaros/core/utils/unknownJsonRecord'

import type { WorkbenchDebuggerLaunchTarget } from '@shared/workbenchDebugger'
import {
  readWorkbenchRunEnvironment,
  type WorkbenchRunEnvironment,
} from '@shared/workbenchRunEnvironment'

import { createLocalStorageJsonStore, type StorageLike } from '../../support/localStorageJsonStore'

import type { WorkbenchRunSessionLaunchOptions } from './workbenchCommandLines'
import { isWorkbenchWindowsHost, quoteWorkbenchShellArgument } from './workbenchShellQuote'

type WorkbenchRunSessionDebugTarget = Extract<
  WorkbenchDebuggerLaunchTarget,
  { kind: 'node-script' }
>

/** `command` 是一条 shell 命令；`node` 是一个 Node.js 程序，由 `node` 起它的脚本，能调试。 */
export type WorkbenchRunConfigurationType = 'command' | 'node'

export interface WorkbenchNamedRunConfiguration {
  id: string
  name: string
  type: WorkbenchRunConfigurationType
  /** `command` 型：在 shell 里执行的命令；`node` 型是空串。 */
  command: string
  /** `node` 型：要跑的脚本，项目里的相对路径（`/` 分隔）；`command` 型是空串。 */
  script: string
  /** `node` 型：传给脚本的参数，shell 里的原文。 */
  args: string
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
 * 工作目录（以及 Node 程序的脚本）收成项目里的相对路径：分隔符统一成 `/`，去掉开头的 `./` 和结尾的 `/`；
 * `.`、空白都是项目根（空串）。绝对路径、带 `..` 的路径不在项目里，返回 null。真去起进程时主进程还会按真实
 * 路径再查一遍。
 */
export function normalizeWorkbenchRunConfigurationCwd(input: string): Nullable<string> {
  const normalized = input.trim().replace(/\\/gu, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return null

  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (segments.includes('..')) return null
  const cwd = segments.join('/')
  return cwd.length > MaxCwdLength ? null : cwd
}

/**
 * 把一份外来的数据读成配置；缺名称、缺 id、命令型缺命令、Node 程序缺脚本（或者脚本不在项目里、长得离谱）的
 * 不算数，返回 null。种类认不出来的当命令型。
 */
export function normalizeWorkbenchNamedRunConfiguration(
  value: unknown
): Nullable<WorkbenchNamedRunConfiguration> {
  if (!isRecord(value)) return null

  const id = isString(value.id) ? value.id.trim() : ''
  const name = isString(value.name) ? value.name.trim() : ''
  if (!id || id.length > MaxIdLength) return null
  if (!name || name.length > WorkbenchRunConfigurationNameMaxLength) return null

  const shared = {
    id,
    name,
    cwd: (isString(value.cwd) ? normalizeWorkbenchRunConfigurationCwd(value.cwd) : null) ?? '',
    env: readWorkbenchRunEnvironment(value.env) ?? {},
  }
  if (value.type === 'node') {
    const script = isString(value.script)
      ? normalizeWorkbenchRunConfigurationCwd(value.script)
      : null
    const args = isString(value.args) ? value.args.trim() : ''
    if (!script || args.length > MaxCommandLength) return null

    return { ...shared, type: 'node', command: '', script, args }
  }

  const command = isString(value.command) ? value.command.trim() : ''
  if (!command || command.length > MaxCommandLength) return null

  return { ...shared, type: 'command', command, script: '', args: '' }
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

/** `path` 相对 `directory` 怎么写（都是项目里的相对路径，`/` 分隔）。 */
function relativeToDirectory(path: string, directory: string): string {
  if (!directory) return path

  const pathSegments = path.split('/')
  const directorySegments = directory.split('/')
  let shared = 0
  while (
    shared < directorySegments.length &&
    shared < pathSegments.length - 1 &&
    pathSegments[shared] === directorySegments[shared]
  )
    shared += 1
  return [...directorySegments.slice(shared).map(() => '..'), ...pathSegments.slice(shared)].join(
    '/'
  )
}

/**
 * 这份配置跑起来执行的命令行：命令型就是它的命令；Node 程序是 `node <脚本> <参数>`，脚本写成相对工作目录的
 * 路径（命令是在工作目录里跑的）。
 */
export function buildWorkbenchRunConfigurationCommand(
  configuration: WorkbenchNamedRunConfiguration,
  windows: boolean = isWorkbenchWindowsHost()
): string {
  if (configuration.type !== 'node') return configuration.command

  const script = quoteWorkbenchShellArgument(
    relativeToDirectory(configuration.script, configuration.cwd),
    windows
  )
  return configuration.args ? `node ${script} ${configuration.args}` : `node ${script}`
}

/** 菜单里名字下面的那行小字：命令，不在项目根跑的再带上目录。 */
export function describeWorkbenchRunConfiguration(
  configuration: WorkbenchNamedRunConfiguration
): string {
  const command = buildWorkbenchRunConfigurationCommand(configuration)
  return configuration.cwd ? `${command} · ${configuration.cwd}` : command
}

/**
 * 跑这份配置时命令之外要交给运行卡的：出自哪份配置，加上它的工作目录、环境变量（没有的不给）。`debug` 是
 * 调试而不是运行——只有 Node 程序能调试，别的种类照常运行。
 */
export function buildWorkbenchRunConfigurationLaunch(
  configuration: WorkbenchNamedRunConfiguration,
  debug = false
): WorkbenchRunSessionLaunchOptions {
  const launch: WorkbenchRunSessionLaunchOptions = { configurationId: configuration.id }
  if (configuration.cwd) launch.cwd = configuration.cwd
  if (Object.keys(configuration.env).length > 0) launch.env = configuration.env
  if (debug && configuration.type === 'node') {
    const target: WorkbenchRunSessionDebugTarget = {
      kind: 'node-script',
      script: configuration.script,
    }
    if (configuration.args) target.args = configuration.args
    launch.debug = { target }
  }
  return launch
}
