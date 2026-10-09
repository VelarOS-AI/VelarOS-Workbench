import { relative, resolve } from 'node:path'

import type { AppLocale } from '@velaros-ai/ui/conversation/contracts'

import type { WorkbenchPermissionConfirmationMode } from '../../shared/workbenchConversation'
import { analyzeWorkbenchCommandExecution } from '../workspace/CommandExecutionPolicy'
import { isRelativePathInsideRoot } from '../workspace/PathContainmentHelper'

import type { EngineConfirmation } from './WorkbenchEngineRunSurface'

/** 确认卡第一行里的命令最多这么长（等回答时卡片只显示这一行）。 */
const TitleCommandChars = 120

/** 引擎要做的一件可能要问用户的事。 */
export type EngineAction =
  | { kind: 'command'; command: string; cwd: string; reason?: string }
  | { kind: 'edit'; paths: readonly string[]; reason?: string }
  | { kind: 'other'; name: string; detail?: string }

/**
 * 外部引擎按各自的命令与编辑请求审批：标准只问危险命令和写到项目之外的文件，从不询问全部放行，
 * 每次都问连写入与命令都问。危险命令按 Workbench 的命令策略判（平台的危险命令加上工作区完整性）。返回
 * null 表示直接放行。
 */
export function engineConfirmation(
  mode: WorkbenchPermissionConfirmationMode,
  action: EngineAction,
  projectRoot: string,
  locale: AppLocale
): Nullable<EngineConfirmation> {
  if (mode === 'never-ask') return null
  const zh = locale !== 'en-US'
  switch (action.kind) {
    case 'command': {
      const plan = analyzeWorkbenchCommandExecution(action.command, projectRoot)
      const command = oneLine(action.command, TitleCommandChars)
      if (plan.isDangerous)
        return {
          title: zh ? `运行危险命令：${command}` : `Run a dangerous command: ${command}`,
          detail: [plan.dangerousReason, action.reason].filter(Boolean).join('\n') || undefined,
          danger: { command: action.command, cwd: action.cwd },
        }
      if (mode === 'standard-open') return null
      return {
        title: zh ? `运行命令：${command}` : `Run command: ${command}`,
        detail: action.reason,
      }
    }
    case 'edit': {
      const outside = action.paths.filter((path) => !isInside(projectRoot, path))
      if (mode === 'standard-open' && outside.length === 0) return null
      const shown = (outside.length > 0 ? outside : action.paths).map((path) =>
        displayPath(projectRoot, path)
      )
      const list = oneLine(shown.join(zh ? '、' : ', '), TitleCommandChars)
      return {
        title:
          outside.length > 0
            ? zh
              ? `修改项目之外的文件：${list}`
              : `Edit files outside the project: ${list}`
            : zh
              ? `修改文件：${list}`
              : `Edit files: ${list}`,
        detail: action.reason,
      }
    }
    case 'other':
      if (mode === 'standard-open') return null
      return {
        title: zh
          ? `使用 ${action.name}${action.detail ? `：${oneLine(action.detail, TitleCommandChars)}` : ''}`
          : `Use ${action.name}${action.detail ? `: ${oneLine(action.detail, TitleCommandChars)}` : ''}`,
      }
  }
}

/** 相对项目根的路径（项目里的）或原样的绝对路径（项目外的）。 */
export function displayPath(projectRoot: string, path: string): string {
  const absolute = resolve(projectRoot, path)
  const inside = relative(resolve(projectRoot), absolute)
  return inside && isRelativePathInsideRoot(inside) ? inside.replaceAll('\\', '/') : absolute
}

/** 项目里的文件相对项目根的路径；项目外的不要。 */
export function projectRelativePaths(projectRoot: string, paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.flatMap((path) => {
        const inside = relative(resolve(projectRoot), resolve(projectRoot, path))
        return inside && isRelativePathInsideRoot(inside) ? [inside.replaceAll('\\', '/')] : []
      })
    ),
  ]
}

function isInside(projectRoot: string, path: string): boolean {
  return isRelativePathInsideRoot(relative(resolve(projectRoot), resolve(projectRoot, path)))
}

/** 压成一行并截短（确认卡标题、工具卡标题用）。 */
export function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}
