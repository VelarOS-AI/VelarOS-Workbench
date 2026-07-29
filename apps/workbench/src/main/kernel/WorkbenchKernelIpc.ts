import { BrowserWindow, ipcMain } from 'electron'

import type {
  WorkbenchKernelCapabilityRoute,
  WorkbenchKernelCapabilityStatus,
  WorkbenchKernelInvocationError,
  WorkbenchKernelInvokeRequest,
  WorkbenchKernelInvokeResult,
  WorkbenchKernelStatus,
} from '../../shared/workbenchKernel'
import { WorkbenchKernelChannels } from '../../shared/workbenchKernel'

import { WorkbenchAgentExecutionEventType } from './WorkbenchAgentCapabilityRuntime'
import {
  WorkbenchKernelCapabilityUnavailableError,
  type WorkbenchKernelRuntime,
} from './WorkbenchKernelRuntime'

export interface WorkbenchKernelCapabilityAddress {
  capabilityId: string
  operation: string
}

export type WorkbenchKernelCapabilityRoutes = Readonly<
  Record<WorkbenchKernelCapabilityRoute, WorkbenchKernelCapabilityAddress>
>

/**
 * 进程内 Kernel 的 renderer 面。
 *
 * 与 daemon 时代的区别只有传输层：路由表仍由组合根注入（renderer 永远不给裸 capabilityId），
 * 状态仍是可订阅投影，Agent 执行事件仍走 `velaros.agent.execution` 广播。没有连接/重试语义——
 * 进程内 host 起即在，起不来就是 degraded，重试等于重启应用。
 */
export function registerWorkbenchKernelIpc(
  runtime: WorkbenchKernelRuntime,
  routes: WorkbenchKernelCapabilityRoutes
): () => void {
  ipcMain.handle(WorkbenchKernelChannels.getStatus, () => projectStatus(runtime))
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
      try {
        return {
          ok: true,
          output: await runtime.invoke(
            route.capabilityId,
            route.operation,
            request.input,
            new AbortController().signal
          ),
        }
      } catch (error) {
        return { ok: false, error: toInvocationError(error) }
      }
    }
  )

  const unsubscribeAgentExecution = runtime.subscribeEvent(
    WorkbenchAgentExecutionEventType,
    (payload) => {
      broadcast(WorkbenchKernelChannels.agentExecution, payload)
    }
  )

  return () => {
    unsubscribeAgentExecution()
    ipcMain.removeHandler(WorkbenchKernelChannels.getStatus)
    ipcMain.removeHandler(WorkbenchKernelChannels.invoke)
  }
}

/** host 起完后广播一次状态：renderer 的可用性门（浏览器面等）据此翻牌。 */
export function broadcastWorkbenchKernelStatus(runtime: WorkbenchKernelRuntime): void {
  broadcast(WorkbenchKernelChannels.statusChanged, projectStatus(runtime))
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function projectStatus(runtime: WorkbenchKernelRuntime): WorkbenchKernelStatus {
  const modules = runtime.listModules()
  const capabilities: WorkbenchKernelCapabilityStatus[] = modules.flatMap((module) =>
    module.status === 'ready'
      ? module.manifest.provides.map((capability) => ({
          id: capability.id,
          version: module.manifest.version,
          moduleId: module.manifest.id,
          moduleVersion: module.manifest.version,
        }))
      : []
  )
  const unhealthy = modules.filter((module) => module.health.status !== 'healthy')
  return {
    state: modules.length === 0 || unhealthy.length > 0 ? 'degraded' : 'ready',
    connected: capabilities.length > 0,
    checkedAt: Date.now(),
    kernelVersion: runtime.version,
    modules: modules.map((module) => ({
      id: module.manifest.id,
      version: module.manifest.version,
      generation: module.generation,
      lifecycleStatus: module.status,
      healthStatus: module.health.status,
      ...(module.error ? { error: module.error } : {}),
    })),
    capabilities,
    error: buildRuntimeError(modules.length, unhealthy),
  }
}

function buildRuntimeError(
  moduleCount: number,
  unhealthy: ReadonlyArray<{ manifest: { id: string } }>
): WorkbenchKernelStatus['error'] {
  if (moduleCount === 0) return {
    code: 'KERNEL_HOST_NOT_STARTED',
    message: '进程内 Kernel 尚未启动或启动失败。',
    retryable: false,
  }
  if (unhealthy.length === 0) return null
  return {
    code: 'KERNEL_HEALTH_DEGRADED',
    message: `Kernel 模块不健康：${unhealthy.map((module) => module.manifest.id).join(', ')}`,
    retryable: false,
  }
}

function isKernelInvokeRequest(
  value: unknown,
  routes: WorkbenchKernelCapabilityRoutes
): value is WorkbenchKernelInvokeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return (
    typeof request.route === 'string'
    && Object.prototype.hasOwnProperty.call(routes, request.route)
    && Object.prototype.hasOwnProperty.call(request, 'input')
  )
}

function toInvocationError(error: unknown): WorkbenchKernelInvocationError {
  if (error instanceof WorkbenchKernelCapabilityUnavailableError) return {
    code: 'KERNEL_CAPABILITY_UNAVAILABLE',
    message: error.message,
    retryable: false,
    details: { capabilityId: error.capabilityId },
  }
  return {
    code: 'KERNEL_INVOCATION_FAILED',
    message: error instanceof Error ? error.message : 'Kernel capability invocation failed',
    retryable: true,
    details: null,
  }
}
