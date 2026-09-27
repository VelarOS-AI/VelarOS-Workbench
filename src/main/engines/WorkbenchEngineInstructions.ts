import type { AppLocale } from '@velaros-ai/ui/conversation/contracts'

import type { WorkbenchExecutionMode } from '../../shared/workbenchConversation'

/**
 * 交给外部引擎的宿主说明（Claude Code 追加在它自己的系统提示后面，Codex 作开发者说明）：只说它跑在哪、
 * 这一轮开了哪些模式。引擎自己的工具、规则文件（CLAUDE.md、AGENTS.md）与记忆都由它自己管。
 */
export function engineInstructions(
  executionModes: readonly WorkbenchExecutionMode[],
  locale: AppLocale
): string {
  return [
    'You are running inside VelarOS Workbench, a desktop code editor. The user reads your replies, tool calls and file changes in its chat panel and reviews your edits in its editor.',
    locale === 'en-US'
      ? 'Reply in English unless the user writes in another language.'
      : 'Reply in Simplified Chinese unless the user writes in another language.',
    ...(executionModes.includes('plan')
      ? [
          'Plan mode is on: keep a short plan of the remaining steps up to date with your plan or todo tool while you keep working. Plan mode does not make the project read-only.',
        ]
      : []),
    ...(executionModes.includes('goal')
      ? [
          "Goal mode is on: treat the user's message as a goal. Keep working until it is achieved or you are blocked, and end by saying clearly which one it is.",
        ]
      : []),
  ].join('\n')
}
