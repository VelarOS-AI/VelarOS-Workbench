import type {
  WorkbenchKernelCapabilityRoute,
  WorkbenchKernelInvokeRequest,
} from '../../shared/workbenchKernel'

export interface WorkbenchKernelCapabilityAddress {
  capabilityId: string
  operation: string
}

export type WorkbenchKernelCapabilityRoutes = Readonly<
  Record<WorkbenchKernelCapabilityRoute, WorkbenchKernelCapabilityAddress>
>

/** Strict renderer-to-main Kernel request boundary. */
export function parseWorkbenchKernelInvokeRequest(
  value: unknown,
  routes: WorkbenchKernelCapabilityRoutes,
): WorkbenchKernelInvokeRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  if (!Object.keys(request).every(
    (key) => key === 'route' || key === 'scope' || key === 'input',
  )) return null
  if (
    !Object.prototype.hasOwnProperty.call(request, 'route')
    || typeof request.route !== 'string'
    || !Object.prototype.hasOwnProperty.call(routes, request.route)
    || !Object.prototype.hasOwnProperty.call(request, 'input')
    || !isWorkbenchScope(request.scope)
  ) return null
  return request as unknown as WorkbenchKernelInvokeRequest
}

function isWorkbenchScope(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  return (
    Object.keys(scope).every(
      (key) => key === 'id' || key === 'ownerModuleId' || key === 'kind',
    )
    && Object.prototype.hasOwnProperty.call(scope, 'id')
    && Object.prototype.hasOwnProperty.call(scope, 'ownerModuleId')
    && Object.prototype.hasOwnProperty.call(scope, 'kind')
    && typeof scope.id === 'string'
    && scope.id.trim().length > 0
    && typeof scope.ownerModuleId === 'string'
    && scope.ownerModuleId.trim().length > 0
    && (
      scope.kind === null
      || (typeof scope.kind === 'string' && scope.kind.trim().length > 0)
    )
  )
}
