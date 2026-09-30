/**
 * 调试器与工作区外壳之间的桥。调试会话的状态、读变量、求值都在按需加载的那一包里
 * （`workbenchDebugSession.ts`），外壳只要知道几件小事，都经这里：
 * - 此刻有没有在调试、是不是停着（快捷键、命令面板、左下角的工具按钮据此开关）；
 * - 把「继续 / 单步 / 结束」交给会话去做；
 * - 会话停下时让页面把文件带到眼前、打开调试面板；
 * - 起一张调试的运行卡（到这一步才去加载会话那一包）。
 */
import type {
  WorkbenchDebuggerLaunchTarget,
  WorkbenchDebuggerStartResult,
} from '@shared/workbenchDebugger'

/** `idle` 没有在调试；`running` 程序在跑（含正在起、还没连上）；`paused` 停着。 */
export type WorkbenchDebugStatus = 'idle' | 'paused' | 'running'

/** 界面上能对调试会话做的动作（快捷键与命令面板用的就是这几个名字）。 */
export type WorkbenchDebugAction =
  | 'continue'
  | 'pause'
  | 'step-into'
  | 'step-out'
  | 'step-over'
  | 'stop'

export interface WorkbenchDebugStartOptions {
  projectRoot: string
  target: WorkbenchDebuggerLaunchTarget
  /** 工作目录：项目里的相对路径；不给是项目根。 */
  cwd?: string
  env?: Record<string, string>
}

/** 会话停下时要页面做的事。 */
export interface WorkbenchDebugPageHooks {
  /** 把项目里的这个位置带到眼前（打开文件、光标落在那一行）。 */
  revealLocation: (location: { path: string; line: number; column: number }) => void
  /** 打开底部的调试面板。 */
  openPanel: () => void
}

let status: WorkbenchDebugStatus = 'idle'
const statusListeners = new Set<() => void>()
let actionRunner: Nullable<(action: WorkbenchDebugAction) => void> = null
let pageHooks: Nullable<WorkbenchDebugPageHooks> = null

/** 会话那一包报状态。 */
export function publishWorkbenchDebugStatus(next: WorkbenchDebugStatus): void {
  if (status === next) return
  status = next
  for (const listener of [...statusListeners]) listener()
}

export function getWorkbenchDebugStatus(): WorkbenchDebugStatus {
  return status
}

export function subscribeWorkbenchDebugStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** 这个动作此刻做不做得了：继续与单步要停着，暂停要在跑，结束只要在调试。 */
export function isWorkbenchDebugActionAvailable(
  action: WorkbenchDebugAction,
  current: WorkbenchDebugStatus = status
): boolean {
  if (action === 'stop') return current !== 'idle'
  return action === 'pause' ? current === 'running' : current === 'paused'
}

/** 会话那一包装上「怎么做这些动作」。 */
export function installWorkbenchDebugActionRunner(
  next: Nullable<(action: WorkbenchDebugAction) => void>
): void {
  actionRunner = next
}

/** 做一个调试动作；此刻做不了（没在调试、没停着）就什么也不做，返回 false。 */
export function runWorkbenchDebugAction(action: WorkbenchDebugAction): boolean {
  if (!actionRunner || !isWorkbenchDebugActionAvailable(action)) return false
  actionRunner(action)
  return true
}

/** 页面装上「怎么把位置带到眼前、怎么打开面板」；卸载时传 null。 */
export function installWorkbenchDebugPageHooks(next: Nullable<WorkbenchDebugPageHooks>): void {
  pageHooks = next
}

export function revealWorkbenchDebugLocation(location: {
  path: string
  line: number
  column: number
}): void {
  pageHooks?.revealLocation(location)
}

export function openWorkbenchDebugPanel(): void {
  pageHooks?.openPanel()
}

/**
 * 起一次调试：程序跑在一个终端会话里（界面上是一张运行卡），返回的 `terminalSessionId` 就是那张卡的会话。
 * 起不来（脚本不在项目里、找不到运行器的入口……）抛出带着原因的错误。
 */
export async function startWorkbenchDebugRunSession(
  options: WorkbenchDebugStartOptions
): Promise<WorkbenchDebuggerStartResult> {
  const { startWorkbenchDebugSession } = await import('./workbenchDebugSession')
  return startWorkbenchDebugSession(options)
}
