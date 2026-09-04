import {
  AgentExecutionPermission,
  AgentKernelModuleId,
} from '@velaros-ai/agent'
import type {
  KernelPermissionBroker,
  KernelPermissionDecision,
  KernelPermissionRequest,
} from '@velaros-ai/kernel/contracts/abi'

const WorkbenchProductId = 'velaros.workbench'

/**
 * Workbench 的高权限 Kernel 路由白名单。
 *
 * The renderer never supplies capability ids, operations, or these authority
 * facts. The main-process route table binds them before the Kernel asks this
 * broker。Agent 执行精确绑定产品路由，其余请求继续 fail-closed。Browser Mod 使用会校验
 * IPC sender 项目所有权的独立 typed host，不通过这条通用 Kernel renderer 面。
 */
export class WorkbenchKernelPermissionPolicy
implements KernelPermissionBroker {
  public request(
    request: KernelPermissionRequest,
  ): Promise<KernelPermissionDecision> {
    const details = request.details
    const isWorkbenchAgentExecution =
      request.moduleId === AgentKernelModuleId
      && request.permission === AgentExecutionPermission
      && details?.productId === WorkbenchProductId
      && details.route === 'agent.execute'
    return Promise.resolve(
      isWorkbenchAgentExecution
        ? {
            status: 'granted',
            grantId: 'workbench:agent.execute',
          }
        : {
            status: 'denied',
            reason: `Workbench does not grant Kernel permission "${request.permission}" for this route`,
          },
    )
  }
}
