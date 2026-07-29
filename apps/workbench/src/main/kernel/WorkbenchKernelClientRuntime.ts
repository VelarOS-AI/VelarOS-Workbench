import { randomUUID } from 'node:crypto'

import {
  type CapabilitySession,
  type ConnectedKernelDaemon,
  connectToKernelDaemon,
  KernelClientError,
  type KernelClientEventHandler,
  type KernelEventSubscription,
  type KernelModPackDescriptor,
  KernelRpcClientError,
} from '@velaros-ai/kernel-client'

import type {
  WorkbenchKernelCapabilityStatus,
  WorkbenchKernelConnectionError,
  WorkbenchKernelHealthSnapshot,
  WorkbenchKernelInvocationError,
  WorkbenchKernelScopeRef,
  WorkbenchKernelStatus,
} from '../../shared/workbenchKernel'

export interface WorkbenchKernelClientRuntimeOptions {
  connect?: () => Promise<ConnectedKernelDaemon>
  startLocal?: () => Promise<WorkbenchOwnedKernelRuntime | null>
  requiredCapabilityIds?: readonly string[]
  now?: () => number
  nextCallId?: () => string
}

export interface WorkbenchOwnedKernelRuntime {
  dispose(): Promise<void>
}

type WorkbenchKernelStatusListener = (status: WorkbenchKernelStatus) => void
type WorkbenchKernelEventListener = (event: Parameters<KernelClientEventHandler>[0]) => void

export interface WorkbenchKernelCapabilityAddress {
  capabilityId: string
  operation: string
}

export class WorkbenchKernelInvocationFailure extends Error {
  public constructor(public readonly invocationError: WorkbenchKernelInvocationError) {
    super(invocationError.message)
    this.name = 'WorkbenchKernelInvocationFailure'
  }
}

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
 * It first discovers and connects to the authenticated local endpoint. When no
 * daemon exists, the injected product-owned starter boots the same Kernel
 * module composition and the client reconnects through local RPC. Concurrent
 * starters converge on the daemon lock instead of creating divergent hosts.
 */
export class WorkbenchKernelClientRuntime {
  private readonly connect: () => Promise<ConnectedKernelDaemon>
  private readonly startLocal?: () => Promise<WorkbenchOwnedKernelRuntime | null>
  private readonly requiredCapabilityIds: readonly string[]
  private readonly now: () => number
  private readonly nextCallId: () => string
  private readonly listeners = new Set<WorkbenchKernelStatusListener>()
  private readonly eventListeners = new Map<string, Set<WorkbenchKernelEventListener>>()
  private readonly eventSubscriptions = new Map<string, KernelEventSubscription>()
  private capabilitySession?: CapabilitySession
  private status: WorkbenchKernelStatus = initialStatus
  private connected?: ConnectedKernelDaemon
  private ownedKernel?: WorkbenchOwnedKernelRuntime
  private inFlight?: Promise<WorkbenchKernelStatus>
  private disposed = false

  public constructor(options: WorkbenchKernelClientRuntimeOptions = {}) {
    this.connect = options.connect ?? connectToKernelDaemon
    this.startLocal = options.startLocal
    this.requiredCapabilityIds = [...new Set(options.requiredCapabilityIds ?? [])]
    this.now = options.now ?? Date.now
    this.nextCallId = options.nextCallId ?? (() =>
      `workbench-${Date.now().toString(36)}-${randomUUID()}`)
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

  public subscribeEvent(eventType: string, listener: WorkbenchKernelEventListener): () => void {
    const listeners = this.eventListeners.get(eventType) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(eventType, listeners)
    void this.installEventSubscription(eventType).catch(() => undefined)
    return () => {
      const current = this.eventListeners.get(eventType)
      current?.delete(listener)
      if (current?.size === 0) {
        this.eventListeners.delete(eventType)
        const subscription = this.eventSubscriptions.get(eventType)
        this.eventSubscriptions.delete(eventType)
        void subscription?.dispose()
      }
    }
  }

  /**
   * Calls a Kernel capability address through the bound capability session.
   *
   * Domain ids and operations are owned by the product composition root. This
   * runtime opens a session for available capabilities and transports the
   * generic Kernel envelope.
   */
  public async invoke(
    address: WorkbenchKernelCapabilityAddress,
    input: unknown,
    scope: WorkbenchKernelScopeRef | null = null,
    signal?: AbortSignal
  ): Promise<unknown> {
    const connected = this.connected
    if (!connected || !this.status.connected) {
      throw new WorkbenchKernelInvocationFailure({
        code: 'KERNEL_UNAVAILABLE',
        message: 'VelarOS Kernel is not connected. Start Kernel and retry.',
        retryable: true,
        details: null,
      })
    }
    if (!this.status.capabilities.some((capability) => capability.id === address.capabilityId)) {
      throw new WorkbenchKernelInvocationFailure({
        code: 'KERNEL_CAPABILITY_UNAVAILABLE',
        message: `Kernel capability "${address.capabilityId}" is not available.`,
        retryable: true,
        details: { capabilityId: address.capabilityId },
      })
    }

    const session = await this.ensureCapabilitySession(connected)
    const response = await session.call({
      protocolVersion: 2,
      callId: this.nextCallId(),
      capabilityId: address.capabilityId,
      operation: address.operation,
      scope,
      input,
    }, signal)
    if (response.status === 'error') {
      throw new WorkbenchKernelInvocationFailure({
        code: response.error.code,
        message: response.error.message,
        retryable: response.error.retryable,
        details: response.error.details,
      })
    }
    return response.output
  }

  /**
   * Kernel 报上来的 mod pack 清单; Kernel 不可达时返回空清单并留降级原因.
   *
   * 与 {@link invoke} 不同——这是 Kernel 自身的窄 RPC（第一级 Module Host 的 pack
   * 目录），不是产品面绑定的领域 capability，因此不经 capability session 网关。
   */
  public async listMods(): Promise<{
    packs: readonly KernelModPackDescriptor[]
    error: Nullable<string>
  }> {
    const connected = this.connected
    if (!connected) return { packs: [], error: 'VelarOS Kernel is not connected.' }
    try {
      const response = await connected.client.listMods()
      return { packs: response.packs, error: null }
    } catch (error) {
      return {
        packs: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.inFlight?.catch(() => undefined)
    const connected = this.connected
    this.connected = undefined
    await this.disposeCapabilitySession()
    await this.disposeEventSubscriptions()
    await connected?.client.dispose()
    const ownedKernel = this.ownedKernel
    this.ownedKernel = undefined
    await ownedKernel?.dispose()
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
      nextConnection = await this.connectOrStart()
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
      await this.disposeEventSubscriptions()
      await this.disposeCapabilitySession()
      this.connected = nextConnection
      await Promise.all([...this.eventListeners.keys()].map((eventType) =>
        this.installEventSubscription(eventType).catch(() => undefined)))
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
      const capabilities = toCapabilityCatalog(nextConnection)
      const availableCapabilityIds = new Set(capabilities.map((capability) => capability.id))
      const missingCapabilityIds = this.requiredCapabilityIds.filter(
        (capabilityId) => !availableCapabilityIds.has(capabilityId)
      )
      const ready = health.status === 'healthy' && missingCapabilityIds.length === 0
      this.updateStatus({
        state: ready ? 'ready' : 'degraded',
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
        capabilities,
        error: missingCapabilityIds.length > 0
          ? {
              code: 'KERNEL_CAPABILITY_UNAVAILABLE',
              message:
                `Kernel daemon is missing required Workbench capabilities: ${
                  missingCapabilityIds.join(', ')
                }`,
              retryable: true,
            }
          : health.status === 'healthy'
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
      await this.disposeCapabilitySession()
      await this.disposeEventSubscriptions()
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

  private async connectOrStart(): Promise<ConnectedKernelDaemon> {
    try {
      return await this.connect()
    } catch (error) {
      if (
        !(error instanceof KernelClientError)
        || error.code !== 'DAEMON_NOT_RUNNING'
        || !this.startLocal
      ) throw error
    }

    try {
      const ownedKernel = await this.startLocal()
      if (this.disposed) {
        await ownedKernel?.dispose()
      } else {
        this.ownedKernel = ownedKernel ?? undefined
      }
    } catch (error) {
      if (!isDaemonAlreadyRunning(error)) throw error
    }
    return this.connect()
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

  private async installEventSubscription(eventType: string): Promise<void> {
    if (
      this.disposed
      || this.eventSubscriptions.has(eventType)
      || !this.eventListeners.has(eventType)
      || !this.connected
    ) return

    const connection = this.connected
    const subscription = await connection.client.subscribe(eventType, (event) => {
      for (const listener of this.eventListeners.get(eventType) ?? []) {
        try {
          listener(event)
        } catch {
          // Event consumers are isolated from the authenticated transport.
        }
      }
    })
    if (this.connected !== connection || this.disposed) {
      await subscription.dispose()
      return
    }
    this.eventSubscriptions.set(eventType, subscription)
  }

  private async disposeEventSubscriptions(): Promise<void> {
    const subscriptions = [...this.eventSubscriptions.values()]
    this.eventSubscriptions.clear()
    await Promise.all(subscriptions.map((subscription) =>
      Promise.resolve(subscription.dispose()).catch(() => undefined)))
  }

  private async ensureCapabilitySession(
    connected: ConnectedKernelDaemon,
  ): Promise<CapabilitySession> {
    if (this.capabilitySession !== undefined) return this.capabilitySession
    const requires = this.status.capabilities.map((capability) => ({
      capabilityId: capability.id,
      operations: null as string[] | null,
      scope: null,
    }))
    if (requires.length === 0) {
      throw new WorkbenchKernelInvocationFailure({
        code: 'KERNEL_CAPABILITY_UNAVAILABLE',
        message: 'Kernel daemon has no capabilities to bind.',
        retryable: true,
        details: null,
      })
    }
    try {
      this.capabilitySession = await connected.client.openCapabilitySession({
        requires,
      })
      return this.capabilitySession
    } catch (error) {
      const code = typeof error === 'object' && error !== null
        && typeof Reflect.get(error, 'code') === 'string'
        ? Reflect.get(error, 'code') as string
        : 'CAPABILITY_BIND_DENIED'
      const message = error instanceof Error
        ? error.message
        : 'Capability session could not be opened'
      throw new WorkbenchKernelInvocationFailure({
        code,
        message,
        retryable: true,
        details: null,
      })
    }
  }

  private async disposeCapabilitySession(): Promise<void> {
    const session = this.capabilitySession
    this.capabilitySession = undefined
    await session?.dispose().catch(() => undefined)
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
  if (error instanceof KernelClientError) return {
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

/** startLocal may throw the daemon-side lock error, which is not a KernelClientError. */
function isDaemonAlreadyRunning(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'code') === 'DAEMON_ALREADY_RUNNING'
}
