import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

import { isWorkbenchEditorTabSavable } from './workbenchEditorSaving'

/**
 * 编辑器自动保存的纯逻辑：哪些标签归自动保存管、什么时候该存、存不下时按文件退避重试。
 *
 * 每个标签各存各的：一个文件写不进去（符号链接、没有权限、磁盘满），只推迟这个文件自己的下一次重试，
 * 不挡住其它标签。
 */

/** 停止输入多久之后自动保存。 */
export const WORKBENCH_EDITOR_AUTOSAVE_DELAY_MS = 3000

const AUTOSAVE_RETRY_BASE_MS = 5000
const AUTOSAVE_RETRY_MAX_MS = 60_000

/** 一个文件最近一次自动保存失败的记录。 */
export interface WorkbenchEditorAutosaveFailure {
  /** 失败原因（写盘错误的说明），标签提示与关窗确认里给用户看。 */
  message: string
  /** 连续失败了几次；存好一次就清掉。 */
  attempts: number
  /** 退避到这个时刻之后再试。 */
  retryAt: number
}

export type WorkbenchEditorAutosaveFailures = ReadonlyMap<string, WorkbenchEditorAutosaveFailure>

/**
 * 自动保存照顾的标签：有完整文本、改过、磁盘那边没有等用户处理的外部修改。上次保存因为文件编码
 * 写不出里面的字符被拒的，改之前结果只会一样，不再自动保存（编辑区另有提示与「转换为 UTF-8」）。
 */
export function isWorkbenchEditorTabAutosavable(tab: WorkbenchOpenEditorTab): boolean {
  return !tab.externalChange && !tab.unencodableSaveError && isWorkbenchEditorTabSavable(tab)
}

/** 第 n 次连续失败之后等多久再试：5 秒起翻倍，最多一分钟。 */
export function resolveWorkbenchEditorAutosaveRetryDelayMs(attempts: number): number {
  return Math.min(
    AUTOSAVE_RETRY_MAX_MS,
    AUTOSAVE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1)
  )
}

export function recordWorkbenchEditorAutosaveFailure(
  failures: WorkbenchEditorAutosaveFailures,
  path: string,
  message: string,
  now: number
): WorkbenchEditorAutosaveFailures {
  const attempts = (failures.get(path)?.attempts ?? 0) + 1
  return new Map(failures).set(path, {
    message,
    attempts,
    retryAt: now + resolveWorkbenchEditorAutosaveRetryDelayMs(attempts),
  })
}

export function clearWorkbenchEditorAutosaveFailure(
  failures: WorkbenchEditorAutosaveFailures,
  path: string
): WorkbenchEditorAutosaveFailures {
  if (!failures.has(path)) return failures

  const next = new Map(failures)
  next.delete(path)
  return next
}

/** 标签关了，或已经不归自动保存管（存好了、撤回了、转成了外部冲突）：它的失败记录作废。 */
export function pruneWorkbenchEditorAutosaveFailures(
  failures: WorkbenchEditorAutosaveFailures,
  tabsByPath: ReadonlyMap<string, WorkbenchOpenEditorTab>
): WorkbenchEditorAutosaveFailures {
  const stalePaths = [...failures.keys()].filter((path) => {
    const tab = tabsByPath.get(path)
    return !tab || !isWorkbenchEditorTabAutosavable(tab)
  })
  if (stalePaths.length === 0) return failures

  const next = new Map(failures)
  stalePaths.forEach((path) => next.delete(path))
  return next
}

/** 这一轮到点该存的标签：没失败过的都算，失败过的等退避时间过了才算。 */
export function selectDueWorkbenchEditorAutosaveTabs(
  tabs: Iterable<WorkbenchOpenEditorTab>,
  failures: WorkbenchEditorAutosaveFailures,
  now: number
): WorkbenchOpenEditorTab[] {
  return [...tabs].filter((tab) => {
    if (!isWorkbenchEditorTabAutosavable(tab)) return false

    const failure = failures.get(tab.path)
    return !failure || failure.retryAt <= now
  })
}

/**
 * 下一次该醒来的时刻：没失败过的标签在输入停顿之后存，失败过的取停顿与退避两者更晚的那个。
 * 没有要存的标签时返回 null。
 */
export function resolveNextWorkbenchEditorAutosaveAt(
  tabs: Iterable<WorkbenchOpenEditorTab>,
  failures: WorkbenchEditorAutosaveFailures,
  now: number
): Nullable<number> {
  let nextAt: Nullable<number> = null
  for (const tab of tabs) {
    if (!isWorkbenchEditorTabAutosavable(tab)) continue

    const dueAt = Math.max(now + WORKBENCH_EDITOR_AUTOSAVE_DELAY_MS, failures.get(tab.path)?.retryAt ?? 0)
    nextAt = nextAt === null ? dueAt : Math.min(nextAt, dueAt)
  }
  return nextAt
}

/** 同一个文件的同一种失败只提示一次；换了原因，或者中间存好过一次，再失败就再提示。 */
export function buildWorkbenchEditorAutosaveNoticeKey(path: string, message: string): string {
  return `${path}\u0000${message}`
}
