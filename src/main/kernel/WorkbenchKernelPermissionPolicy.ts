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
 * Explicit permission policy for Workbench's only privileged Kernel route.
 *
 * The renderer never supplies capability ids, operations, or these authority
 * facts. The main-process route table binds them before the Kernel asks this
 * broker. Everything outside that one product-owned path remains fail-closed.
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
        ? { status: 'granted', grantId: 'workbench:agent.execute' }
        : {
            status: 'denied',
            reason: `Workbench does not grant Kernel permission "${request.permission}" for this route`,
          },
    )
  }
}
