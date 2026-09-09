// 域：Workbench 工具审批的**判定策略**（纯函数，零 IO、零 this）。
//
// 「这次确认要不要弹卡 / 能不能复用本会话已给过的答案」是安全边界上的判据，和装配代码分开住：
// 判据必须能被逐条读、逐条测。接线在 WorkbenchAgentExecutionStack，规则在这里。
import type {
  PermissionConfirmationMode,
  ToolApprovalRiskLevel,
  ToolConfirmationDecisionOptions,
} from '@velaros-ai/agent/protocol'

/** 缺省风险按高算：漏标的新工具应当更谨慎，不是更宽松。 */
function resolveApprovalRisk(options?: ToolConfirmationDecisionOptions): ToolApprovalRiskLevel {
  return options?.approvalRisk === 'low' ? 'low' : 'high'
}

/** 风险类别标识；空白视作缺席。 */
function resolveConfirmationRiskScope(
  options?: ToolConfirmationDecisionOptions
): Nullable<string> {
  const scope = options?.riskScope?.trim()
  return scope ? scope : null
}

/** 破坏性风险类别的约定：riskScope 以 `:dangerous` 结尾。 */
function isDangerousRiskScope(options?: ToolConfirmationDecisionOptions): boolean {
  return !!resolveConfirmationRiskScope(options)?.endsWith(':dangerous')
}

/**
 * 本次确认能否按策略自动放行。
 *
 * 两条硬门在**任何**权限模式下都成立，包括「完全访问」：
 * 1. `requireManualApproval`——工具文案已经承诺「等你确认」的地方（实施计划、阻塞式动作卡），
 *    自动放行等于把门拆了；
 * 2. `:dangerous` 风险类别——破坏性命令每次都问。它此前只在 never-ask 生效，于是默认档反而
 *    比「完全访问」更松：standard-open 会落到会话记忆，首次批准把整个类别记进 Set，此后同会话
 *    静默放行；用户点头的是 `rm -rf ./node_modules`，之后跑的可能是 `rm -rf ~/Documents`。
 *
 * @param input.hasConfirmedRiskScope 本会话是否已授权过该风险类别（会话级 Set，永不清空）。
 */
export function shouldAutoApproveWorkbenchToolConfirmation(input: {
  permissionConfirmationMode: PermissionConfirmationMode
  hasConfirmedRiskScope: (riskScope: string) => boolean
  options?: ToolConfirmationDecisionOptions
}): boolean {
  const { options } = input
  if (options?.requireManualApproval) return false
  if (isDangerousRiskScope(options)) return false

  switch (input.permissionConfirmationMode) {
    case 'never-ask':
      return true
    case 'ask-every-time':
      return false
    default:
      break
  }

  if (resolveApprovalRisk(options) === 'low') return true

  const riskScope = resolveConfirmationRiskScope(options)
  return !!riskScope && input.hasConfirmedRiskScope(riskScope)
}

/** 权限确认策略的默认档：低风险直接放行、高风险首次询问。 */
export const DefaultWorkbenchPermissionConfirmationMode: PermissionConfirmationMode =
  'standard-open'

/** 把不可信输入收敛成合法的权限确认策略；无法识别时回落默认档。 */
export function normalizeWorkbenchPermissionConfirmationMode(
  value: unknown
): PermissionConfirmationMode {
  return value === 'never-ask' || value === 'ask-every-time' || value === 'standard-open'
    ? value
    : DefaultWorkbenchPermissionConfirmationMode
}
