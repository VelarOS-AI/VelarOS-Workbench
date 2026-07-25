import { isEmpty } from '@velaros/core'
import type { WorkbenchEditorCommand } from '@velaros/core/types'

export type WorkbenchEditorAutomationPhase =
  | 'preparing'
  | 'deleting'
  | 'typing'
  | 'saving'
  | 'finishing'

export interface WorkbenchEditorAutomationState {
  commandId: string
  action: WorkbenchEditorCommand['action']
  path: Nullable<string>
  phase: WorkbenchEditorAutomationPhase
  progress: number
}

export interface WorkbenchEditorAnimationPlan {
  prefix: string
  beforeMiddle: string
  afterMiddle: string
  suffix: string
  deleteFrameCount: number
  typeFrameCount: number
}

function commonPrefixLength(before: string, after: string): number {
  const limit = Math.min(before.length, after.length)
  let index = 0
  while (index < limit && before[index] === after[index]) index += 1
  return index
}

function commonSuffixLength(before: string, after: string, prefixLength: number): number {
  const limit = Math.min(before.length, after.length) - prefixLength
  let length = 0
  while (
    length < limit &&
    before[before.length - length - 1] === after[after.length - length - 1]
  ) {
    length += 1
  }
  return length
}

/** 把一次文本变化压缩成“删除旧片段 → 输入新片段”的视觉播放计划。 */
export function buildWorkbenchEditorAnimationPlan(
  before: string,
  after: string
): WorkbenchEditorAnimationPlan {
  const prefixLength = commonPrefixLength(before, after)
  const suffixLength = commonSuffixLength(before, after, prefixLength)
  const beforeMiddleEnd = before.length - suffixLength
  const afterMiddleEnd = after.length - suffixLength
  const beforeMiddle = before.slice(prefixLength, beforeMiddleEnd)
  const afterMiddle = after.slice(prefixLength, afterMiddleEnd)

  return {
    prefix: before.slice(0, prefixLength),
    beforeMiddle,
    afterMiddle,
    suffix: suffixLength > 0 ? after.slice(afterMiddleEnd) : '',
    deleteFrameCount: isEmpty(beforeMiddle)
      ? 0
      : Math.min(18, Math.max(1, Math.ceil(beforeMiddle.length / 48))),
    typeFrameCount: isEmpty(afterMiddle)
      ? 0
      : Math.min(140, Math.max(1, Math.ceil(afterMiddle.length / 24))),
  }
}

export function buildWorkbenchEditorDeleteFrame(
  plan: WorkbenchEditorAnimationPlan,
  frame: number
): string {
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, plan.deleteFrameCount)))
  const keep = Math.floor(plan.beforeMiddle.length * (1 - progress))
  return `${plan.prefix}${plan.beforeMiddle.slice(0, keep)}${plan.suffix}`
}

export function buildWorkbenchEditorTypeFrame(
  plan: WorkbenchEditorAnimationPlan,
  frame: number
): string {
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, plan.typeFrameCount)))
  const typed = Math.ceil(plan.afterMiddle.length * progress)
  return `${plan.prefix}${plan.afterMiddle.slice(0, typed)}${plan.suffix}`
}
