/**
 * 断点：用户在 JavaScript / TypeScript 文件的行号上点出来的「文件 + 行号」，加上「未捕获的异常时暂停」这个开关。
 *
 * 按项目（项目根路径）存在应用自己的存储里，与运行配置同一种做法：不往用户的仓库里写文件，重启应用之后还在。
 * 读出来的每一项重新校验（路径、行号、数量），存储里的东西可能被手改过。
 *
 * 编辑器的行号栏、调试会话、调试面板都读这里；改了就通知订阅者。这个模块不在工作区外壳包里，跟着编辑器
 * 和调试面板按需加载。
 */
import { isArray, isString, Log } from '@velaros-ai/core'
import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { WorkbenchDebuggerBreakpoint } from '@shared/workbenchDebugger'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../support/localStorageJsonStore'

export const WORKBENCH_BREAKPOINTS_STORAGE_KEY = 'velaros.workbench.breakpoints.v1'

/** 与主进程一次肯收的断点数一致：再多不是人手点出来的。 */
const MaxBreakpointsPerProject = 2_000
/** 只留最近动过断点的这么多个项目，早先的丢掉：存储不会跟着打开过的项目一直长。 */
const MaxProjects = 64
const MaxPathLength = 1_000
const DebuggableFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/iu
const log = Log.tag('workbench-breakpoints')

export interface WorkbenchProjectBreakpoints {
  /** 按文件、再按行号排好。 */
  breakpoints: WorkbenchDebuggerBreakpoint[]
  /** 程序抛出没人接住的异常时停下。 */
  pauseOnUncaughtExceptions: boolean
}

type StoredBreakpoints = Record<string, WorkbenchProjectBreakpoints>

/** 能下断点的文件：调试器只管 Node.js 上的 JavaScript / TypeScript。 */
export function isWorkbenchDebuggableFilePath(path: LooseOptional<string>): boolean {
  return !!path && DebuggableFilePattern.test(path)
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
}

/** 项目里的相对路径：不是绝对路径，也不往项目外面走。 */
function isProjectRelativePath(path: string): boolean {
  return (
    !!path &&
    path.length <= MaxPathLength &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.split('/').includes('..')
  )
}

function compareBreakpoints(
  left: WorkbenchDebuggerBreakpoint,
  right: WorkbenchDebuggerBreakpoint
): number {
  return left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1
}

function normalizeBreakpointList(value: unknown): WorkbenchDebuggerBreakpoint[] {
  if (!isArray(value)) return []

  const seen = new Set<string>()
  const breakpoints: WorkbenchDebuggerBreakpoint[] = []
  for (const item of value) {
    if (!isRecord(item) || !isString(item.path)) continue
    const path = normalizePath(item.path)
    const line = item.line
    if (!isProjectRelativePath(path)) continue
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue

    const key = `${path}\0${line}`
    if (seen.has(key)) continue
    seen.add(key)
    breakpoints.push({ path, line })
    if (breakpoints.length >= MaxBreakpointsPerProject) break
  }
  return breakpoints.sort(compareBreakpoints)
}

function normalizeProjectBreakpoints(value: unknown): WorkbenchProjectBreakpoints {
  const record = isRecord(value) ? value : {}
  return {
    breakpoints: normalizeBreakpointList(record.breakpoints),
    // 没说过就是停：程序要崩的地方正是要看的地方。
    pauseOnUncaughtExceptions: record.pauseOnUncaughtExceptions !== false,
  }
}

function isDefault(project: WorkbenchProjectBreakpoints): boolean {
  return project.breakpoints.length === 0 && project.pauseOnUncaughtExceptions
}

function normalizeStoredBreakpoints(value: unknown): StoredBreakpoints {
  if (!isRecord(value)) return {}

  const result: StoredBreakpoints = {}
  for (const [projectRoot, project] of Object.entries(value).slice(-MaxProjects)) {
    const normalized = normalizeProjectBreakpoints(project)
    if (!isDefault(normalized)) result[projectRoot] = normalized
  }
  return result
}

const breakpointStore = createLocalStorageJsonStore<StoredBreakpoints>({
  key: WORKBENCH_BREAKPOINTS_STORAGE_KEY,
  fallback: () => ({}),
  normalize: normalizeStoredBreakpoints,
  log,
  readErrorMessage: '读取 workbench 断点失败，当作没有断点',
  writeErrorMessage: '写入 workbench 断点失败',
})

/** 读过的项目留在内存里：行号栏每次重画都要问，不能回回去解析存储。 */
const projects = new Map<string, WorkbenchProjectBreakpoints>()
const listeners = new Set<() => void>()

function projectOf(projectRoot: string, storage?: StorageLike): WorkbenchProjectBreakpoints {
  let project = projects.get(projectRoot)
  if (!project || storage) {
    project = normalizeProjectBreakpoints(breakpointStore.read(storage)[projectRoot])
    if (!storage) projects.set(projectRoot, project)
  }
  return project
}

function writeProject(
  projectRoot: string,
  project: WorkbenchProjectBreakpoints,
  storage?: StorageLike
): void {
  if (!storage) projects.set(projectRoot, project)
  breakpointStore.update((stored) => {
    // 重新插到最后：最近动过的排在后面，超出项目数上限时丢的是最早的。
    const { [projectRoot]: _previous, ...rest } = stored
    return isDefault(project) ? rest : { ...rest, [projectRoot]: project }
  }, storage)
  for (const listener of [...listeners]) listener()
}

/** 这个项目的全部断点（按文件、行号排好）。返回的数组在断点变之前是同一个，可以直接拿来比较。 */
export function readWorkbenchBreakpoints(
  projectRoot: string,
  storage?: StorageLike
): readonly WorkbenchDebuggerBreakpoint[] {
  return projectOf(projectRoot, storage).breakpoints
}

/** 这个文件里下了断点的行号（从 1 起，升序）。 */
export function readWorkbenchBreakpointLines(
  projectRoot: string,
  path: string,
  storage?: StorageLike
): number[] {
  const normalized = normalizePath(path)
  return projectOf(projectRoot, storage)
    .breakpoints.filter((breakpoint) => breakpoint.path === normalized)
    .map((breakpoint) => breakpoint.line)
}

/**
 * 整份换掉一个文件里的断点行：点行号下 / 摘断点、编辑让断点挪了行，编辑器都把这个文件此刻的断点行交过来。
 * 与存着的一样就什么也不做（不通知）。
 */
export function setWorkbenchBreakpointLines(
  projectRoot: string,
  path: string,
  lines: readonly number[],
  storage?: StorageLike
): void {
  const normalized = normalizePath(path)
  const project = projectOf(projectRoot, storage)
  const breakpoints = normalizeBreakpointList([
    ...project.breakpoints.filter((breakpoint) => breakpoint.path !== normalized),
    ...lines.map((line) => ({ path: normalized, line })),
  ])
  if (JSON.stringify(breakpoints) === JSON.stringify(project.breakpoints)) return

  writeProject(projectRoot, { ...project, breakpoints }, storage)
}

/** 这一行有断点就摘掉，没有就下一个。 */
export function toggleWorkbenchBreakpoint(
  projectRoot: string,
  path: string,
  line: number,
  storage?: StorageLike
): void {
  const lines = readWorkbenchBreakpointLines(projectRoot, path, storage)
  setWorkbenchBreakpointLines(
    projectRoot,
    path,
    lines.includes(line) ? lines.filter((candidate) => candidate !== line) : [...lines, line],
    storage
  )
}

export function readWorkbenchExceptionPause(projectRoot: string, storage?: StorageLike): boolean {
  return projectOf(projectRoot, storage).pauseOnUncaughtExceptions
}

export function setWorkbenchExceptionPause(
  projectRoot: string,
  pauseOnUncaughtExceptions: boolean,
  storage?: StorageLike
): void {
  const project = projectOf(projectRoot, storage)
  if (project.pauseOnUncaughtExceptions === pauseOnUncaughtExceptions) return

  writeProject(projectRoot, { ...project, pauseOnUncaughtExceptions }, storage)
}

/** 任何项目的断点或异常开关变了都通知（订阅者自己看是不是它关心的那个项目）。 */
export function subscribeWorkbenchBreakpoints(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
