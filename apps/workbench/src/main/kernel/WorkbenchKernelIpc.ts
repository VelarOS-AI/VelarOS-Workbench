import { BrowserWindow, ipcMain } from 'electron'

import type {
  WorkbenchKernelCapabilityRoute,
  WorkbenchKernelInvocationError,
  WorkbenchKernelInvokeRequest,
  WorkbenchKernelInvokeResult,
} from '../../shared/workbenchKernel'
import { WorkbenchKernelChannels } from '../../shared/workbenchKernel'

import {
  type WorkbenchKernelCapabilityAddress,
  type WorkbenchKernelClientRuntime,
  WorkbenchKernelInvocationFailure,
} from './WorkbenchKernelClientRuntime'

export type WorkbenchKernelCapabilityRoutes = Readonly<
  Record<WorkbenchKernelCapabilityRoute, WorkbenchKernelCapabilityAddress>
>

export function registerWorkbenchKernelIpc(
  runtime: WorkbenchKernelClientRuntime,
  routes: WorkbenchKernelCapabilityRoutes
): () => void {
  ipcMain.handle(WorkbenchKernelChannels.getStatus, () => runtime.getStatus())
  ipcMain.handle(WorkbenchKernelChannels.retry, () => runtime.retry())
  ipcMain.handle(
    WorkbenchKernelChannels.invoke,
    async (_event, request: unknown): Promise<WorkbenchKernelInvokeResult> => {
      if (!isKernelInvokeRequest(request, routes)) return {
        ok: false,
        error: {
          code: 'KERNEL_REQUEST_INVALID',
          message: 'Workbench Kernel invocation request is invalid.',
          retryable: false,
          details: null,
        },
      }
      const route = routes[request.route]
      if (!route) return {
        ok: false,
        error: {
          code: 'KERNEL_ROUTE_UNAVAILABLE',
          message: `Workbench Kernel route "${request.route}" is not installed.`,
          retryable: false,
          details: null,
        },
      }
      try {
        return {
          ok: true,
          output: await runtime.invoke(route, request.input, request.scope ?? null),
        }
      } catch (error) {
        return { ok: false, error: toInvocationError(error) }
      }
    }
  )

  const unsubscribe = runtime.subscribe((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(WorkbenchKernelChannels.statusChanged, status)
      }
    }
  })
  const unsubscribeAgentExecution = runtime.subscribeEvent(
    'velaros.agent.execution',
    (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(
            WorkbenchKernelChannels.agentExecution,
            event.payload
          )
        }
      }
    }
  )

  return () => {
    unsubscribe()
    unsubscribeAgentExecution()
    ipcMain.removeHandler(WorkbenchKernelChannels.getStatus)
    ipcMain.removeHandler(WorkbenchKernelChannels.retry)
    ipcMain.removeHandler(WorkbenchKernelChannels.invoke)
  }
}

function isKernelInvokeRequest(
  value: unknown,
  routes: WorkbenchKernelCapabilityRoutes
): value is WorkbenchKernelInvokeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  if (
    typeof request.route !== 'string'
    || !Object.prototype.hasOwnProperty.call(routes, request.route)
    || !Object.prototype.hasOwnProperty.call(request, 'input')
  ) return false
  if (request.scope === undefined || request.scope === null) return true
  if (typeof request.scope !== 'object' || Array.isArray(request.scope)) return false
  const scope = request.scope as Record<string, unknown>
  return (
    typeof scope.id === 'string'
    && typeof scope.ownerModuleId === 'string'
    && (scope.kind === null || typeof scope.kind === 'string')
  )
}

function toInvocationError(error: unknown): WorkbenchKernelInvocationError {
  if (error instanceof WorkbenchKernelInvocationFailure) return error.invocationError
  return {
    code: 'KERNEL_INVOCATION_FAILED',
    message: error instanceof Error ? error.message : 'Kernel capability invocation failed',
    retryable: true,
    details: null,
  }
}
