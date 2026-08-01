import { Log } from '@velaros-ai/core'
import type {
  CapabilityToken,
  KernelCallableCapabilityService,
  KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'
import { KernelModuleHost, type KernelModuleSnapshot } from '@velaros-ai/core/kernel/host'

/** Kernel module API 版本轴；mod manifest 的 `engines.velaros` 对它判定兼容。 */
const WorkbenchKernelVersion = '0.3.0'
/**
 * Workbench 自报的 Agent capability API 版本（对 mod manifest 的 `engines.agent`）。
 *
 * 领域轴的兼容判定用它，与 Kernel module API 轴（{@link WorkbenchKernelVersion}）分开演进。
 */
const WorkbenchAgentCapabilityApiVersion = '1.0.0'
/** module ABI 轴：manifest 的 `apiVersion` 必须与之相等才准注册。 */
const WorkbenchKernelModuleApiVersion = 1

const log = Log.tag('WorkbenchKernelRuntime')

/**
 * Workbench 的进程内 Kernel。
 *
 * kernel-contract §15.1 原则一（库优先，进程可选）+ §15.2 层间铁律：完整宿主**进程内装栈**，
 * 不经 kernel-client、不拉 daemon 进程、不架 HostBridge。本类是 Kernel 库
 * （`@velaros-ai/core/kernel` 的 module host）在 Workbench 侧的门面：组装期
 * {@link registerModule} 把能力模块注册进来，`whenReady` 期 {@link start} 一次性
 * activate + ready，之后能力经服务注册表进程内直取。
 *
 * 与 Desktop 的差异只在**装了哪些能力**：Workbench 只自持 Agent 能力，model / browser
 * 没有本体因此不注册——{@link hasCapability} 为假，消费面按既有降级路径走。
 *
 * 能力模块起不来不 brick 启动：{@link start} 吞掉失败并留可读日志，装配链照常走。
 */
class WorkbenchKernelRuntime {
  private readonly host = new KernelModuleHost({
    apiVersion: WorkbenchKernelModuleApiVersion,
  })
  private startPromise?: Promise<void>
  private disposePromise?: Promise<void>
  private started = false

  /** Kernel module API 版本；mod manifest 的 `engines.velaros` 对它判定兼容。 */
  public get version(): string {
    return WorkbenchKernelVersion
  }

  /** 注册一个能力模块；必须在 {@link start} 之前调用（host 只从 registered 态启动）。 */
  public registerModule(definition: KernelModuleDefinition): void {
    this.host.registerModule(definition)
  }

  public start(): Promise<void> {
    this.startPromise ??= this.startOnce()
    return this.startPromise
  }

  /** 该能力当前是否有活跃提供者；进程内注册表查询，无远端往返。 */
  public hasCapability(capabilityId: string): boolean {
    return this.listModules().some(
      (module) =>
        module.status === 'ready'
        && module.manifest.provides.some((capability) => capability.id === capabilityId)
    )
  }

  /** 取一个已注册能力的服务；未注册（或模块未起）时返回 undefined，调用方自行降级。 */
  public getCapability<TService extends object>(
    token: CapabilityToken<TService>
  ): TService | undefined {
    return this.host.getOptionalService(token)
  }

  public listModules(): readonly KernelModuleSnapshot[] {
    return this.started ? this.host.listModules() : []
  }

  /**
   * 调一个能力操作；能力缺席时抛 {@link WorkbenchKernelCapabilityUnavailableError}。
   *
   * 进程内直取服务注册表，无信封、无 RPC、无 capability session 网关——权限判定仍在
   * 能力自身的 operation metadata 里（宿主进程即信任边界）。
   */
  public async invoke(
    capabilityId: string,
    operation: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    // 令牌带版本轴，服务注册表按 (id, version) 双键查；因此这里从已注册模块的 manifest
    // 取回真令牌，而不是凭 id 造一个（造出来的版本对不上就永远查空）。
    const token = this.findCapabilityToken(capabilityId)
    const service = token
      ? this.getCapability<KernelCallableCapabilityService>(
          token as CapabilityToken<KernelCallableCapabilityService>
        )
      : undefined
    if (!service) throw new WorkbenchKernelCapabilityUnavailableError(capabilityId)
    return service.invoke(operation, undefined, input, signal)
  }

  private findCapabilityToken(capabilityId: string): CapabilityToken | undefined {
    for (const module of this.listModules()) {
      if (module.status !== 'ready') continue

      const token = module.manifest.provides.find(
        (capability) => capability.id === capabilityId
      )
      if (token) return token
    }
    return undefined
  }

  /** 订阅一个 Kernel 事件类型；host 未起时返回 no-op 退订器。 */
  public subscribeEvent(
    type: string,
    handler: (payload: unknown) => void
  ): () => void {
    const registration = this.host.subscribe(type, (event) => {
      handler(event.payload)
    })
    return () => registration.dispose()
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  private async startOnce(): Promise<void> {
    try {
      await this.host.start()
      this.started = true
    } catch (error) {
      log.warn('kernel.module_host_start_failed', {
        error: error instanceof Error ? error.message : String(error),
        hint: 'Workbench 继续运行但没有进程内 Kernel 能力；依赖它们的 mod 保持未激活。',
      })
    }
  }

  private async disposeOnce(): Promise<void> {
    this.started = false
    await this.host.dispose().catch((error) => {
      log.warn('kernel.module_host_dispose_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}

/** 请求的能力没有活跃提供者；调用方据此给出可读降级，而不是当成执行失败。 */
class WorkbenchKernelCapabilityUnavailableError extends Error {
  public constructor(public readonly capabilityId: string) {
    super(`Kernel 能力「${capabilityId}」在本进程未注册。`)
    this.name = 'WorkbenchKernelCapabilityUnavailableError'
  }
}

export {
  WorkbenchAgentCapabilityApiVersion,
  WorkbenchKernelCapabilityUnavailableError,
  WorkbenchKernelRuntime,
  WorkbenchKernelVersion,
}
