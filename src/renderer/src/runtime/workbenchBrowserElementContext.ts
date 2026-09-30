import { truncate } from '@velaros-ai/core'

import type { BrowserElementSelection } from '@shared/contracts'

/**
 * 用户在浏览器里拾取的页面元素 → 本轮模型可见的上下文段（与 Desktop useChatComposerSubmission 同一格式）。
 *
 * interaction_chain 是用户在拾取模式里的完整链路：select 只选取不触发页面，click 是用户按组合键
 * 触发的真实点击——后续元素可能已经消失，但模型仍应按链路理解和复现。
 */
type BrowserElementSelectionStep = NonNullable<BrowserElementSelection['interactionSteps']>[number]

const SummarizedAttributes = ['id', 'name', 'type', 'role', 'aria-label', 'data-testid', 'placeholder']

function formatAttributeSummary(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .filter(([key]) => SummarizedAttributes.includes(key))
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')
}

function formatSnapshot(selection: BrowserElementSelection | BrowserElementSelectionStep): string[] {
  const attributes = formatAttributeSummary(selection.attributes)
  return [
    selection.label,
    `tag=${selection.tagName}`,
    selection.role ? `role=${selection.role}` : null,
    selection.selector ? `selector=${selection.selector}` : null,
    selection.text ? `text="${truncate(selection.text, 240)}"` : null,
    attributes ? `attrs=${attributes}` : null,
    `rect=${selection.rect.x},${selection.rect.y},${selection.rect.width}x${selection.rect.height}`,
    `center=${selection.rect.centerX},${selection.rect.centerY}`,
    `viewport=${selection.viewportWidth}x${selection.viewportHeight}`,
    `url=${selection.url}`,
  ].filter((part): part is string => !!part)
}

export function formatBrowserElementSelectionsForPrompt(
  selections: readonly BrowserElementSelection[]
): string {
  if (selections.length === 0) return ''

  const lines = selections.map((selection, index) => {
    const parts = [`${index + 1}. current=${formatSnapshot(selection).join('\n   ')}`]
    const chain = selection.interactionSteps ?? []
    if (chain.length > 0)
      parts.push(
        'interaction_chain:',
        ...chain.map((step) =>
          [
            `   ${step.sequence}. action=${step.action === 'click' ? 'click(real page action)' : 'select(pointer only)'}`,
            ...formatSnapshot(step).map((part) => `      ${part}`),
          ].join('\n')
        )
      )
    return parts.join('\n   ')
  })

  return [
    '用户在当前浏览器页面手动选择了元素，请优先结合它们理解本轮意图。interaction_chain 是用户在拾取模式里的完整链路；select 表示只选取不触发页面，click(real page action) 表示用户按组合键触发了页面真实点击，后续元素可能已经消失但仍应按链路理解和复现：',
    ...lines,
  ].join('\n')
}

/**
 * 只选了元素、没打字时，用户气泡与会话标题显示这一句。怎么说（「已选择页面元素：…」）、元素之间用什么隔开，
 * 由调用方按界面语言给。
 */
export function buildBrowserElementDisplayFallback(
  selections: readonly BrowserElementSelection[],
  wording: { separator: string; describe: (elements: string) => string }
): string {
  if (selections.length === 0) return ''
  return wording.describe(
    truncate(selections.map((selection) => selection.label).join(wording.separator), 120)
  )
}
