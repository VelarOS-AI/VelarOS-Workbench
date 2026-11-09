import type { AppError } from '@velaros-ai/velaros/core/error'

import { type WorkbenchReadFileResult } from '@shared/contracts/workbench'

import type {
  WorkbenchOpenEditorExternalChange,
  WorkbenchOpenEditorTab,
} from '../../types/workbenchTypes'

import { canSaveWorkbenchTabContent } from './workbenchEditorEditMode'
import { isDirtyTab } from './workbenchEditorTabs'
import {
  resolveWorkbenchTabTextFormat,
  resolveWorkbenchTextConversion,
} from './workbenchEditorTextFormat'

/**
 * 编辑器保存的纯逻辑：一次写盘的结果、写盘之间的快照接力、批量保存的汇总。
 *
 * 手动保存、自动保存、全部保存与关闭前保存都走同一条写盘路径，按这里的结果各自决定怎么提示。
 */

/** 一次保存的结果。 */
export type WorkbenchEditorSaveResult =
  | { status: 'saved'; file: WorkbenchReadFileResult }
  /** 没有可存的：内容没改、文件不完整不能写回，或同一文件的自动保存正在写（下一轮再来）。 */
  | { status: 'skipped' }
  /** 磁盘上的版本变了或文件没了：先由用户决定留哪一份。 */
  | { status: 'conflict'; change: WorkbenchOpenEditorExternalChange }
  | { status: 'failed'; error: AppError }

/** 一次写盘把哪个磁盘快照存成了哪个。 */
export interface WorkbenchEditorSavedSnapshot {
  base: WorkbenchReadFileResult
  saved: WorkbenchReadFileResult
}

/** 写盘只确认这次保存的正文与格式；等待期间的新草稿仍归当前标签持有。 */
export function mergeWorkbenchEditorSavedTab(
  currentTab: WorkbenchOpenEditorTab,
  requestedTab: WorkbenchOpenEditorTab,
  saved: WorkbenchReadFileResult
): WorkbenchOpenEditorTab {
  const currentFormat = resolveWorkbenchTabTextFormat(currentTab)
  const requestedFormat = resolveWorkbenchTabTextFormat(requestedTab)
  const unchanged =
    currentTab.content === requestedTab.content &&
    currentFormat.encoding === requestedFormat.encoding &&
    currentFormat.eol === requestedFormat.eol

  return {
    ...currentTab,
    file: saved,
    content: currentTab.content === requestedTab.content ? saved.content : currentTab.content,
    textConversion: resolveWorkbenchTextConversion(saved, currentFormat),
    externalChange:
      currentTab.externalChange === requestedTab.externalChange
        ? undefined
        : currentTab.externalChange,
    unencodableSaveError: unchanged ? undefined : currentTab.unencodableSaveError,
  }
}

const MAX_SAVED_SNAPSHOT_TRAIL = 8

/**
 * 这次写盘该拿哪个快照去跟磁盘比。
 *
 * 排队的下一次保存（全部保存与自动保存交错、连按保存）捕获的标签仍可能是上次写盘前的快照。沿着写盘
 * 记录按对象身份往后找，用最新存下的那一份，避免误报外部修改；请求时选定的格式同时保留，不能因基线
 * 更新就把「恢复原格式」解释成「沿用新格式」。状态换成别的快照、记录接不上时原样返回。
 */
export function resolveWorkbenchEditorSaveTab(
  tab: WorkbenchOpenEditorTab,
  trail: readonly WorkbenchEditorSavedSnapshot[]
): WorkbenchOpenEditorTab {
  let current = tab.file
  for (let hop = 0; hop < trail.length; hop += 1) {
    const next = trail.find((entry) => entry.base === current)
    if (!next) break
    current = next.saved
  }
  return current === tab.file
    ? tab
    : {
        ...tab,
        file: current,
        textConversion: resolveWorkbenchTextConversion(current, resolveWorkbenchTabTextFormat(tab)),
      }
}

export function appendWorkbenchEditorSavedSnapshot(
  trail: readonly WorkbenchEditorSavedSnapshot[],
  entry: WorkbenchEditorSavedSnapshot
): WorkbenchEditorSavedSnapshot[] {
  return [...trail, entry].slice(-MAX_SAVED_SNAPSHOT_TRAIL)
}

export interface WorkbenchEditorSaveSummary {
  savedPaths: string[]
  conflicts: Array<{ path: string; change: WorkbenchOpenEditorExternalChange }>
  failures: Array<{ path: string; error: AppError }>
}

/** 把一批保存结果按「存好 / 冲突 / 失败」归拢，跳过的不计。 */
export function summarizeWorkbenchEditorSaveResults(
  results: ReadonlyMap<string, WorkbenchEditorSaveResult>
): WorkbenchEditorSaveSummary {
  const summary: WorkbenchEditorSaveSummary = { savedPaths: [], conflicts: [], failures: [] }
  for (const [path, result] of results) {
    switch (result.status) {
      case 'saved': {
        summary.savedPaths.push(path)
        break
      }
      case 'conflict': {
        summary.conflicts.push({ path, change: result.change })
        break
      }
      case 'failed': {
        summary.failures.push({ path, error: result.error })
        break
      }
    }
  }
  return summary
}

/**
 * 需要写回磁盘、也写得回去的标签：有完整文本（磁盘字节写不回原样的，要选过转换），并且改过
 * （内容与磁盘快照不同，或选了还没存下去的格式转换）。
 */
export function isWorkbenchEditorTabSavable(tab: WorkbenchOpenEditorTab): boolean {
  return canSaveWorkbenchTabContent(tab) && isDirtyTab(tab)
}
