import { createHash } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BrowserWindow, ipcMain } from 'electron'

import { AgentCapabilityExecutionEventType } from '@velaros-ai/agent/protocol/agent-capability'
import {
  type ScopeRef,
  UnknownKernelCapabilityOperationError,
} from '@velaros-ai/kernel/contracts/abi'
import {
  type Kernel,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from '@velaros-ai/kernel/runtime'

import type {
  WorkbenchChatHistoryBackupResult,
  WorkbenchKernelCapabilityStatus,
  WorkbenchKernelInvocationError,
  WorkbenchKernelInvokeRequest,
  WorkbenchKernelInvokeResult,
  WorkbenchKernelRuntimeState,
  WorkbenchKernelStatus,
} from '../../shared/workbenchKernel'
import { WorkbenchKernelChannels } from '../../shared/workbenchKernel'
import { type WorkbenchAppStoragePaths } from '../workspace/StoragePaths'

import {
  parseWorkbenchKernelInvokeRequest,
  type WorkbenchKernelCapabilityRoutes,
} from './WorkbenchKernelProtocol'

export type {
  WorkbenchKernelCapabilityAddress,
  WorkbenchKernelCapabilityRoutes,
} from './WorkbenchKernelProtocol'

/**
 * 进程内 Kernel 的 renderer 面。
 *
 * 与 daemon 时代的区别只有传输层：路由表仍由组合根注入（renderer 永远不给裸 capabilityId），
 * 状态仍是可订阅投影，Agent 执行事件仍走 `velaros.agent.execution` 广播。没有连接/重试语义——
 * 进程内 host 起即在，起不来就是 degraded，重试等于重启应用。
 */
export function registerWorkbenchKernelIpc(
  runtime: Kernel,
  routes: WorkbenchKernelCapabilityRoutes,
  storagePaths: WorkbenchAppStoragePaths
): () => void {
  const activeAgentExecutions = new Map<string, AbortController>()
  ipcMain.handle(WorkbenchKernelChannels.getStatus, () => projectStatus(runtime))
  ipcMain.handle(
    WorkbenchKernelChannels.backupChatHistory,
    async (_event, request: unknown): Promise<WorkbenchChatHistoryBackupResult> =>
      writeChatHistoryBackup(storagePaths, request)
  )
  ipcMain.handle(
    WorkbenchKernelChannels.invoke,
    async (_event, request: unknown): Promise<WorkbenchKernelInvokeResult> => {
      const parsed = parseWorkbenchKernelInvokeRequest(request, routes)
      if (!parsed) return {
        ok: false,
        error: {
          code: 'KERNEL_REQUEST_INVALID',
          message: 'Workbench Kernel invocation request is invalid.',
          retryable: false,
          details: null,
        },
      }
      const route = routes[parsed.route]
      const executionId = parsed.route === 'agent.execute'
        ? readAgentExecutionId(parsed.input)
        : null
      const controller = new AbortController()
      if (executionId) activeAgentExecutions.set(executionId, controller)
      try {
        return {
          ok: true,
          output: await runtime.invokeCapability({
            capabilityId: route.capabilityId,
            operation: route.operation,
            scope: toKernelScope(parsed.scope),
            input: parsed.input,
            signal: controller.signal,
            permissionContext: {
              details: {
                productId: 'velaros.workbench',
                route: parsed.route,
              },
            },
          }),
        }
      } catch (error) {
        return { ok: false, error: toInvocationError(error) }
      } finally {
        if (executionId && activeAgentExecutions.get(executionId) === controller) {
          activeAgentExecutions.delete(executionId)
        }
      }
    }
  )
  ipcMain.handle(WorkbenchKernelChannels.abortAgentExecution, (_event, request: unknown) => {
    const executionId = readAbortExecutionId(request)
    if (!executionId) return false
    const controller = activeAgentExecutions.get(executionId)
    if (!controller) return false
    controller.abort('Stopped by the user.')
    return true
  })

  const unsubscribeAgentExecution = runtime.subscribeEvent(
    AgentCapabilityExecutionEventType,
    (payload) => {
      broadcast(WorkbenchKernelChannels.agentExecution, payload)
    }
  )

  return () => {
    unsubscribeAgentExecution()
    ipcMain.removeHandler(WorkbenchKernelChannels.getStatus)
    ipcMain.removeHandler(WorkbenchKernelChannels.invoke)
    ipcMain.removeHandler(WorkbenchKernelChannels.abortAgentExecution)
    ipcMain.removeHandler(WorkbenchKernelChannels.backupChatHistory)
  }
}

function readAgentExecutionId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const execution = (input as { execution?: unknown }).execution
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return null
  const id = (execution as { id?: unknown }).id
  return typeof id === 'string' && id.trim() ? id : null
}

function readAbortExecutionId(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const id = (request as { executionId?: unknown }).executionId
  return typeof id === 'string' && id.trim() ? id : null
}

/** host 起完后广播一次状态：renderer 的可用性门（浏览器面等）据此翻牌。 */
export function broadcastWorkbenchKernelStatus(runtime: Kernel): void {
  broadcast(WorkbenchKernelChannels.statusChanged, projectStatus(runtime))
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function projectStatus(runtime: Kernel): WorkbenchKernelStatus {
  const modules = runtime.listModules()
  const runtimeStatus = runtime.getStatus()
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
  const state = projectRuntimeState(runtimeStatus, capabilities.length, unhealthy.length)
  return {
    state,
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
    error: buildRuntimeError(runtimeStatus, modules.length, unhealthy),
  }
}

function projectRuntimeState(
  status: ReturnType<Kernel['getStatus']>,
  capabilityCount: number,
  unhealthyCount: number
): WorkbenchKernelRuntimeState {
  if (status === 'idle' || status === 'starting') return 'starting'
  if (status === 'disposed' || status === 'disposing') return 'disposed'
  if (status === 'degraded' || capabilityCount === 0 || unhealthyCount > 0) return 'degraded'
  return 'ready'
}

function buildRuntimeError(
  status: ReturnType<Kernel['getStatus']>,
  moduleCount: number,
  unhealthy: ReadonlyArray<{ manifest: { id: string } }>
): WorkbenchKernelStatus['error'] {
  if (status === 'idle' || status === 'starting') return null
  if (status === 'disposed' || status === 'disposing') return {
    code: 'KERNEL_DISPOSED',
    message: '进程内 Kernel 已停止。',
    retryable: false,
  }
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

function toKernelScope(
  value: WorkbenchKernelInvokeRequest['scope']
): ScopeRef | undefined {
  if (!value) return undefined
  return {
    id: value.id,
    ownerModuleId: value.ownerModuleId,
    ...(value.kind === null ? {} : { kind: value.kind }),
  }
}

function toInvocationError(error: unknown): WorkbenchKernelInvocationError {
  if (error instanceof KernelCapabilityUnavailableError) return {
    code: 'KERNEL_CAPABILITY_UNAVAILABLE',
    message: error.message,
    retryable: false,
    details: { capabilityId: error.capabilityId },
  }
  if (error instanceof UnknownKernelCapabilityOperationError) return {
    code: 'KERNEL_OPERATION_UNAVAILABLE',
    message: error.message,
    retryable: false,
    details: null,
  }
  if (error instanceof KernelCapabilityPermissionDeniedError) return {
    code: 'KERNEL_PERMISSION_DENIED',
    message: error.message,
    retryable: false,
    details: {
      capabilityId: error.capabilityId,
      operation: error.operation,
      permission: error.permission,
    },
  }
  return {
    code: 'KERNEL_INVOCATION_FAILED',
    message: error instanceof Error ? error.message : 'Kernel capability invocation failed',
    retryable: true,
    details: null,
  }
}

/**
 * 把 renderer 送来的聊天历史原样落盘。
 *
 * 主进程**不解释 payload 的形状**——它是不透明字符串。这样做是刻意的：会话权威目前仍在
 * renderer（已知欠账），本函数只是防「localStorage 被清空或撞配额即全丢」的兜底出口；
 * 一旦会话权威上收到主进程，这条通道整条删掉即可，不留需要迁移的 schema。
 *
 * 先写 `.tmp` 再 rename，避免写到一半崩溃留下半截 JSON 覆盖掉上一份完好备份。
 */
async function writeChatHistoryBackup(
  storagePaths: WorkbenchAppStoragePaths,
  request: unknown
): Promise<WorkbenchChatHistoryBackupResult> {
  if (typeof request !== 'object' || request === null) return { ok: false, message: 'Chat history backup request is invalid.' }

  const { projectRoot, payload } = request as Record<string, unknown>
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || typeof payload !== 'string') return { ok: false, message: 'Chat history backup request is invalid.' }

  // 项目根不能直接当文件名（含分隔符且可能超长）；取稳定摘要做分片键。
  const shard = createHash('sha256').update(projectRoot).digest('hex').slice(0, 32)
  const targetPath = join(storagePaths.getChatHistoryBackupsDir(), `${shard}.json`)
  const temporaryPath = `${targetPath}.tmp`

  try {
    await writeFile(temporaryPath, payload, 'utf8')
    await rename(temporaryPath, targetPath)
    return { ok: true, path: targetPath }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Chat history backup failed.',
    }
  }
}
