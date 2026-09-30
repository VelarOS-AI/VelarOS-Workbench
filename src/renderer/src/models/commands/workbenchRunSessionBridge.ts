/**
 * 运行卡与编辑区之间的桥。编辑区（按需加载的那一包）要起一张运行卡、要知道这张卡是怎么结束的，都经这里：
 * 页面装上「怎么起」，终端事件那一层报「结束了」，编辑区里的功能（测试的 ▶）订阅。这样运行卡的状态不必一层层
 * 作为属性传进编辑器组件。
 */
import type { WorkbenchRunSessionLaunchOptions } from './workbenchCommandLines'

/** 起一张运行卡；返回会话 id，没起成（没有项目、启动失败，已提示用户）返回 null。 */
export type WorkbenchRunSessionLauncher = (
  command: string,
  label?: string,
  launch?: WorkbenchRunSessionLaunchOptions
) => Promise<Nullable<string>>

export interface WorkbenchRunSessionExit {
  sessionId: string
  exitCode: Nullable<number>
  /** 被信号结束（用户点了停止、关了卡）：进程自己没有给出结论。 */
  interrupted: boolean
}

let launcher: Nullable<WorkbenchRunSessionLauncher> = null
const exitListeners = new Set<(exit: WorkbenchRunSessionExit) => void>()
const restartListeners = new Set<(previousSessionId: string, nextSessionId: string) => void>()

/** 页面装上起运行卡的办法；卸载时传 null。 */
export function installWorkbenchRunSessionLauncher(next: Nullable<WorkbenchRunSessionLauncher>): void {
  launcher = next
}

export async function launchWorkbenchRunSession(
  command: string,
  label?: string,
  launch?: WorkbenchRunSessionLaunchOptions
): Promise<Nullable<string>> {
  return launcher ? launcher(command, label, launch) : null
}

/** 终端会话收口了（进程退出）：报给关心它的人。 */
export function publishWorkbenchRunSessionExit(exit: WorkbenchRunSessionExit): void {
  for (const listener of [...exitListeners]) listener(exit)
}

export function onWorkbenchRunSessionExit(
  listener: (exit: WorkbenchRunSessionExit) => void
): () => void {
  exitListeners.add(listener)
  return () => exitListeners.delete(listener)
}

/** 一张运行卡被重启：同一张卡换了会话，之前跟着旧会话的人改跟新的。 */
export function publishWorkbenchRunSessionRestart(
  previousSessionId: string,
  nextSessionId: string
): void {
  for (const listener of [...restartListeners]) listener(previousSessionId, nextSessionId)
}

export function onWorkbenchRunSessionRestart(
  listener: (previousSessionId: string, nextSessionId: string) => void
): () => void {
  restartListeners.add(listener)
  return () => restartListeners.delete(listener)
}
