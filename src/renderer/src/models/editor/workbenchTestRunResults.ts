/**
 * 从编辑器里跑的测试最近一次的结果：▶ 旁边标着通过还是没通过。
 *
 * 结果只看运行卡的退出码（0 是通过），不解析运行器的输出。一次运行对应一张运行卡：卡还在跑时标「运行中」，
 * 被用户停掉的没有结论，标记回到普通的 ▶；卡被重启后接着跟新的那次运行。结果只在这次打开应用期间留着。
 * 调试的那张卡不算数（见 useWorkbenchEditorRunDebug）：停在断点上的时间会让运行器报超时。
 */
import {
  onWorkbenchRunSessionExit,
  onWorkbenchRunSessionRestart,
} from '../commands/workbenchRunSessionBridge'

export type WorkbenchTestRunStatus = 'running' | 'passed' | 'failed'

/** 记着这么多张运行卡各是哪个测试起的；再多就忘掉最早的。 */
const MaxTrackedSessions = 200

const statuses = new Map<string, WorkbenchTestRunStatus>()
/** 运行卡的会话 → 它跑的是哪个测试（结果表的键）。 */
const sessionKeys = new Map<string, string>()
const listeners = new Set<() => void>()
let subscribed = false

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function setStatus(key: string, status: Nullable<WorkbenchTestRunStatus>): void {
  if (status) statuses.set(key, status)
  else statuses.delete(key)
  notify()
}

/** 第一次有测试跑起来时才去订阅运行卡的收口与重启。 */
function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true

  onWorkbenchRunSessionExit((exit) => {
    const key = sessionKeys.get(exit.sessionId)
    if (key === undefined) return
    setStatus(key, exit.interrupted ? null : exit.exitCode === 0 ? 'passed' : 'failed')
  })
  onWorkbenchRunSessionRestart((previousSessionId, nextSessionId) => {
    const key = sessionKeys.get(previousSessionId)
    if (key === undefined) return
    sessionKeys.delete(previousSessionId)
    trackWorkbenchTestRun(key, nextSessionId)
  })
}

/** 结果表的键：哪个项目的哪个文件里、全名匹配哪个正则的测试（整个文件是空串）。 */
export function workbenchTestRunResultKey(
  projectRoot: string,
  path: string,
  pattern: string
): string {
  return `${projectRoot}\0${path}\0${pattern}`
}

export function readWorkbenchTestRunStatus(key: string): Nullable<WorkbenchTestRunStatus> {
  return statuses.get(key) ?? null
}

/** 这个测试由这张运行卡在跑：标成运行中，等它收口。 */
export function trackWorkbenchTestRun(key: string, sessionId: string): void {
  ensureSubscribed()
  // 同一个测试上一次的运行卡还记着的话不再管它：它后来才结束也不该盖掉这一次的结果。
  for (const [trackedSession, trackedKey] of sessionKeys) {
    if (trackedKey === key) sessionKeys.delete(trackedSession)
  }
  sessionKeys.set(sessionId, key)
  while (sessionKeys.size > MaxTrackedSessions) {
    const oldest = sessionKeys.keys().next().value
    if (oldest === undefined) break
    sessionKeys.delete(oldest)
  }
  setStatus(key, 'running')
}

export function subscribeWorkbenchTestRunResults(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
