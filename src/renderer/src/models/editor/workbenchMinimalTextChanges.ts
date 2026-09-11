import { diffChars, diffLines } from 'diff'

/** 一处文本改动：把原文的 `from..to` 换成 `insert`（坐标都按原文算）。 */
export interface WorkbenchTextChange {
  from: number
  to: number
  insert: string
}

/** 整次比对最多花这么久；超时的部分退回整段替换，别让格式化卡住编辑器。 */
const DiffBudgetMs = 150
/** 一段改动在这个长度以内才逐字细分；再长就整段替换。 */
const MaxRefinedHunkChars = 16_000

/**
 * 把「整篇换成 after」拆成最小的一组改动：先逐行找出改了哪几段，再在每段里逐字细分。
 *
 * 整篇替换会让编辑器里按位置记的东西（光标、讲解气泡、AI 选区、行内评论）全部失去位置——它们都落在
 * 被替换的区间里，只能塌到开头或结尾。拆成最小改动后，只改了缩进、引号、分号的行都还在原处。
 */
export function buildWorkbenchMinimalTextChanges(before: string, after: string): WorkbenchTextChange[] {
  if (before === after) return []
  const deadline = Date.now() + DiffBudgetMs
  const parts = diffLines(before, after, { timeout: DiffBudgetMs })
  if (!parts) return [{ from: 0, to: before.length, insert: after }]

  const changes: WorkbenchTextChange[] = []
  let position = 0
  let removed = ''
  let added = ''
  const flush = (): void => {
    if (!removed && !added) return
    changes.push(...refineHunk(position, removed, added, deadline - Date.now()))
    position += removed.length
    removed = ''
    added = ''
  }
  for (const part of parts) {
    if (part.removed) removed += part.value
    else if (part.added) added += part.value
    else {
      flush()
      position += part.value.length
    }
  }
  flush()
  return changes
}

/** 逐行比出来的一段改动（原文从 `from` 起的 `removed` 换成 `added`），在段内逐字细分。 */
function refineHunk(
  from: number,
  removed: string,
  added: string,
  budgetMs: number
): WorkbenchTextChange[] {
  const whole = [{ from, to: from + removed.length, insert: added }]
  if (!removed || !added || budgetMs <= 0 || removed.length + added.length > MaxRefinedHunkChars)
    return whole
  const parts = diffChars(removed, added, { timeout: budgetMs })
  if (!parts) return whole

  const changes: WorkbenchTextChange[] = []
  let position = from
  let pending: WorkbenchTextChange | null = null
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (pending) changes.push(pending)
      pending = null
      position += part.value.length
      continue
    }
    pending ??= { from: position, to: position, insert: '' }
    if (part.removed) {
      pending.to += part.value.length
      position += part.value.length
    } else {
      pending.insert += part.value
    }
  }
  if (pending) changes.push(pending)
  return changes
}
