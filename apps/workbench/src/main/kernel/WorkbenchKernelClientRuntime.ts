import {
  type ConnectedKernelDaemon,
  connectToKernelDaemon,
  KernelDaemonError,
  KernelRpcClientError,
} from '@velaros-ai/kernel-service'

import type {
  WorkbenchKernelCapabilityStatus,
  WorkbenchKernelConnectionError,
  WorkbenchKernelHealthSnapshot,
  WorkbenchKernelStatus,
} from '../../shared/workbenchKernel'

export interface WorkbenchKernelClientRuntimeOptions {
  connect?: () => Promise<ConnectedKernelDaemon>
  now?: () => number
}

type WorkbenchKernelStatusListener = (status: WorkbenchKernelStatus) => void

const initialStatus: WorkbenchKernelStatus = {
  state: 'connecting',
  connected: false,
  checkedAt: null,
  daemon: null,
  handshake: null,
  health: null,
  capabilities: [],
  error: null,
}

/**
 * Workbench's composition root for the shared Kernel daemon.
 *
 * It only discovers and connects to the authenticated local endpoint. It never
 * starts a daemon or constructs a fallback Kernel host, so Desktop, Workbench,
 * and future products cannot silently diverge into multiple sources of truth.
 */
export class WorkbenchKernelClientRuntime {
  private readonly connect: () => Promise<ConnectedKernelDaemon>
  private readonly now: () => number
  private readonly listeners = new Set<WorkbenchKernelStatusListener>()
  private status: WorkbenchKernelStatus = initialStatus
  private connected?: ConnectedKernelDaemon
  private inFlight?: Promise<WorkbenchKernelStatus>
  private disposed = false

  public constructor(options: WorkbenchKernelClientRuntimeOptions = {}) {
    this.connect = options.connect ?? connectToKernelDaemon
    this.now = options.now ?? Date.now
  }

  public getStatus(): WorkbenchKernelStatus {
    return this.status
  }

  public start(): Promise<WorkbenchKernelStatus> {
    return this.retry()
  }

  public retry(): Promise<WorkbenchKernelStatus> {
    if (this.disposed) return Promise.resolve(this.status)
    if (this.inFlight) return this.inFlight

    this.updateStatus({
      ...this.status,
      state: 'connecting',
      error: null,
    })
    const attempt = this.connectOnce().finally(() => {
      if (this.inFlight === attempt) this.inFlight = undefined
    })
    this.inFlight = attempt
    return attempt
  }

  public subscribe(listener: WorkbenchKernelStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.inFlight?.catch(() => undefined)
    const connected = this.connected
    this.connected = undefined
    await connected?.client.dispose()
    this.updateStatus({
      ...this.status,
      state: 'disposed',
      connected: false,
      checkedAt: this.now(),
    })
    this.listeners.clear()
  }

  private async connectOnce(): Promise<WorkbenchKernelStatus> {
    let nextConnection: ConnectedKernelDaemon | undefined
    try {
      nextConnection = await this.connect()
      if (this.disposed) {
        await nextConnection.client.dispose()
        return this.status
      }

      const health = await nextConnection.client.health()
      if (this.disposed) {
        await nextConnection.client.dispose()
        return this.status
      }

      const previous = this.connected
      this.connected = nextConnection
      if (previous && previous !== nextConnection) {
        await previous.client.dispose()
      }

      const healthSnapshot: WorkbenchKernelHealthSnapshot = {
        status: health.status,
        modules: health.modules.map((module) => ({
          id: module.id,
          version: module.version,
          generation: module.generation,
          lifecycleStatus: module.status,
          healthStatus: module.health.status,
          ...(module.error ? { error: module.error } : {}),
        })),
      }
      this.updateStatus({
        state: health.status === 'healthy' ? 'ready' : 'degraded',
        connected: true,
        checkedAt: this.now(),
        daemon: {
          instanceId: nextConnection.descriptor.instanceId,
          pid: nextConnection.descriptor.pid,
          startedAt: nextConnection.descriptor.startedAt,
        },
        handshake: {
          protocolVersion: nextConnection.handshake.protocolVersion,
          kernelVersion: nextConnection.handshake.kernelVersion,
          moduleCount: nextConnection.handshake.modules.length,
        },
        health: healthSnapshot,
        capabilities: toCapabilityCatalog(nextConnection),
        error: health.status === 'healthy'
          ? null
          : {
              code: 'KERNEL_HEALTH_DEGRADED',
              message: 'Kernel daemon is connected but not fully healthy',
              retryable: true,
            },
      })
    } catch (error) {
      if (nextConnection) {
        await Promise.resolve(nextConnection.client.dispose()).catch(() => undefined)
      }
      const previous = this.connected
      this.connected = undefined
      if (previous) {
        await Promise.resolve(previous.client.dispose()).catch(() => undefined)
      }
      if (!this.disposed) {
        this.updateStatus({
          state: 'degraded',
          connected: false,
          checkedAt: this.now(),
          daemon: null,
          handshake: null,
          health: null,
          capabilities: [],
          error: toConnectionError(error),
        })
      }
    }
    return this.status
  }

  private updateStatus(status: WorkbenchKernelStatus): void {
    this.status = status
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch {
        // One renderer observer must not corrupt the daemon connection state.
      }
    }
  }
}

function toCapabilityCatalog(
  connection: ConnectedKernelDaemon
): readonly WorkbenchKernelCapabilityStatus[] {
  return connection.handshake.modules.flatMap((module) =>
    module.provides.map((capability) => ({
      id: capability.id,
      version: capability.version,
      moduleId: module.id,
      moduleVersion: module.version,
      catalogRevision: module.catalogRevision,
    }))
  )
}

function toConnectionError(error: unknown): WorkbenchKernelConnectionError {
  if (error instanceof KernelDaemonError) return {
      code: error.code,
      message: error.message,
      retryable: error.code !== 'PROTOCOL_VERSION_MISMATCH',
    }
  if (error instanceof KernelRpcClientError) return {
      code: error.rpcError.code,
      message: error.message,
      retryable: error.rpcError.retryable,
    }
  return {
    code: 'KERNEL_CONNECTION_FAILED',
    message: error instanceof Error
      ? error.message
      : 'Kernel daemon connection failed',
    retryable: true,
  }
}
