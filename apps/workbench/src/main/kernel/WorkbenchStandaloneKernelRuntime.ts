import {
  type ModelMessage,
  stepCountIs,
  tool,
  type ToolSet,
} from 'ai'
import { z } from 'zod'

import {
  type AgentCapabilityExecutionContext,
  type AgentCapabilityRuntime,
  type AgentModelStreamInput,
  AiSdkAgentModelRequestPort,
  createAgentKernelModule,
} from '@velaros-ai/agent-runtime'
import {
  createBrowserKernelModule,
  ElectronBrowserRuntime,
} from '@velaros-ai/browser-runtime'
import { AppError } from '@velaros-ai/core/error'
import { KernelModuleHost } from '@velaros-ai/kernel-host'
import {
  type KernelPermissionBroker,
  type KernelPermissionRequest,
  type ScopeRef,
} from '@velaros-ai/kernel-sdk'
import {
  type KernelDaemonEndpointDescriptor,
  KernelDaemonError,
  KernelLocalDaemon,
  KernelService,
} from '@velaros-ai/kernel-service'
import {
  createModelKernelModule,
} from '@velaros-ai/model-runtime'
import {
  createModelRuntimeComposition,
  type ModelRuntimeComposition,
} from '@velaros-ai/model-runtime/node'
import {
  createWorkspaceKernelModule,
  type VelarosWorkspaceBridge,
  type WorkspaceBridgeResolver,
} from '@velaros-ai/workspace'

import type { WorkbenchWorkspaceCapabilityProvider } from '../workspace/PublishedWorkspaceCapabilityProvider'

import { WorkbenchBrowserController } from './WorkbenchBrowserController'

const WorkbenchWorkspaceScopeOwner = 'velaros.workbench.workspace-scope'
const AgentExecutionEventType = 'velaros.agent.execution'

const grantedPermissions = new Set([
  'agent:execute',
  'browser:control',
  'fs:read',
  'fs:write',
  'process:exec',
])

class WorkbenchKernelPermissionBroker implements KernelPermissionBroker {
  public request(
    request: KernelPermissionRequest
  ): Promise<{ status: 'granted' } | { status: 'denied'; reason: string }> {
    if (grantedPermissions.has(request.permission)) return Promise.resolve({ status: 'granted' })
    return Promise.resolve({
      status: 'denied',
      reason: `Workbench RPC policy does not grant "${request.permission}"`,
    })
  }
}

interface WorkbenchAgentExecutionSource {
  productId: string
  sessionId: string
  correlationId: string
}

interface WorkbenchAgentModelSelection {
  provider: string
  model: string
  apiKey: string
  baseURL: string
}

interface WorkbenchAgentExecuteInput {
  protocolVersion: 1
  executionId: string
  source: WorkbenchAgentExecutionSource
  scopeMetadata: Record<string, unknown>
  projectRoot: string
  modelSelection: WorkbenchAgentModelSelection
  browserSessionId: string
  messages: ModelMessage[]
}

function parseAgentExecuteInput(
  input: unknown,
  scope: ScopeRef | undefined
): WorkbenchAgentExecuteInput {
  const record = requireRecord(input, 'Agent execution input must be an object.')
  const allowedKeys = new Set(['protocolVersion', 'execution', 'messages', 'config'])
  if (
    record.protocolVersion !== 1
    || Object.keys(record).some((key) => !allowedKeys.has(key))
    || scope !== undefined
    || !Array.isArray(record.messages)
  ) {
    throw new AppError('VALIDATION', 'Agent execution input is invalid.')
  }

  const execution = requireRecord(
    record.execution,
    'Agent execution descriptor must be an object.'
  )
  const allowedExecutionKeys = new Set(['id', 'source', 'scopeMetadata'])
  if (Object.keys(execution).some((key) => !allowedExecutionKeys.has(key))) {
    throw new AppError('VALIDATION', 'Agent execution descriptor is invalid.')
  }
  const source = requireRecord(
    execution.source,
    'Agent execution source must be an object.'
  )
  const allowedSourceKeys = new Set(['productId', 'sessionId', 'correlationId'])
  if (Object.keys(source).some((key) => !allowedSourceKeys.has(key))) {
    throw new AppError('VALIDATION', 'Agent execution source is invalid.')
  }
  const scopeMetadata = requireRecord(
    execution.scopeMetadata,
    'Agent execution scope metadata must be an object.'
  )
  if (Object.keys(scopeMetadata).length > 128) {
    throw new AppError('VALIDATION', 'Agent execution scope metadata is invalid.')
  }
  const projectRoot = requireBoundedIdentifier(
    scopeMetadata.resourceId,
    'Agent execution resourceId'
  )
  const config = requireRecord(record.config, 'Agent execution config must be an object.')
  const modelSelection = requireRecord(
    config.modelSelection,
    'Agent model selection must be an object.'
  )
  const allowedModelSelectionKeys = new Set(['provider', 'model', 'apiKey', 'baseURL'])
  if (Object.keys(modelSelection).some((key) => !allowedModelSelectionKeys.has(key))) {
    throw new AppError(
      'VALIDATION',
      'Agent model selection is invalid.'
    )
  }

  const executionSource: WorkbenchAgentExecutionSource = {
    productId: requireBoundedIdentifier(
      source.productId,
      'Agent source productId',
      128
    ),
    sessionId: requireBoundedIdentifier(source.sessionId, 'Agent source sessionId'),
    correlationId: requireBoundedIdentifier(
      source.correlationId,
      'Agent source correlationId'
    ),
  }
  return {
    protocolVersion: 1,
    executionId: requireBoundedIdentifier(execution.id, 'Agent execution id'),
    source: executionSource,
    scopeMetadata,
    projectRoot,
    modelSelection: {
      provider: requireBoundedIdentifier(
        modelSelection.provider,
        'Agent model provider',
        128
      ),
      model: requireBoundedIdentifier(modelSelection.model, 'Agent model id'),
      apiKey: requireString(modelSelection.apiKey, 'Agent model apiKey must be a string.'),
      baseURL: requireString(
        modelSelection.baseURL,
        'Agent model baseURL must be a string.'
      ).trim(),
    },
    browserSessionId: `${executionSource.sessionId}:browser`,
    messages: record.messages as ModelMessage[],
  }
}

class WorkbenchAgentCapabilityRuntime implements AgentCapabilityRuntime {
  private readonly requestPort = new AiSdkAgentModelRequestPort()
  private readonly executions = new Map<string, AbortController>()

  public constructor(
    private readonly models: ModelRuntimeComposition,
    private readonly workspace: WorkbenchWorkspaceCapabilityProvider,
    private readonly browser: WorkbenchBrowserController,
    private readonly isWorkspaceRootAllowed: (projectRoot: string) => boolean
  ) {}

  public async execute(
    scope: ScopeRef | undefined,
    rawInput: unknown,
    context: AgentCapabilityExecutionContext
  ): Promise<unknown> {
    const input = parseAgentExecuteInput(rawInput, scope)
    if (!this.isWorkspaceRootAllowed(input.projectRoot)) {
      throw new AppError(
        'PERMISSION',
        `Workspace root "${input.projectRoot}" is not active in Workbench.`
      )
    }
    if (this.executions.has(input.executionId)) {
      throw new AppError('CONFLICT', `Execution "${input.executionId}" already exists.`)
    }
    const controller = new AbortController()
    this.executions.set(input.executionId, controller)
    const signal = AbortSignal.any([context.signal, controller.signal])
    const publish = (
      channel: 'agent' | 'state',
      payload: Record<string, unknown>
    ) =>
      context.publish(AgentExecutionEventType, {
        protocolVersion: 1,
        executionId: input.executionId,
        sourceProductId: input.source.productId,
        sourceSessionId: input.source.sessionId,
        sessionCorrelationId: input.source.correlationId,
        channel,
        payload,
      })

    try {
      await publish('state', {
        kind: 'start',
        scopeMetadata: input.scopeMetadata,
        browserSessionId: input.browserSessionId,
      })
      const selection = input.modelSelection
      const resolved = await this.models.agentModelRuntime.resolveRoleRuntime(
        {
          provider: selection.provider,
          model: selection.model,
          apiKey: '',
          baseURL: '',
        },
        {
          providerRuntimeConfigs: [{
            provider: selection.provider,
            enabled: true,
            apiKey: selection.apiKey,
            baseURL: selection.baseURL,
            defaultModel: selection.model,
          }],
          openRouter: { useFreeModelsForDebug: false },
        }
      )
      const bridge = await this.workspace.resolveBridge(input.projectRoot)
      const tools = this.createTools(bridge, input)
      const stream = this.requestPort.openAgentStreamTurn({
        model: resolved.provider(resolved.providerModel, {
          ...(resolved.modelRequestOptions ?? {}),
          runtimeContext: {
            ...(resolved.modelRequestOptions?.runtimeContext ?? {}),
            sessionId: input.source.sessionId,
          },
        }),
        system: [
          'You are the VelarOS Workbench Agent.',
          `The active project root is ${input.projectRoot}.`,
          'Inspect before editing. Use Workspace tools for project files and Browser tools for pages.',
          'Finish with a concise summary of what changed and validation performed.',
        ].join('\n'),
        messages: input.messages,
        tools,
        stopWhen: stepCountIs(12),
        providerOptions: resolved.modelRequestOptions
          ?.providerOptions as AgentModelStreamInput<ToolSet>['providerOptions'],
        abortSignal: signal,
      })
      let text = ''
      for await (const delta of stream.textStream) {
        signal.throwIfAborted()
        text += delta
        await publish('agent', { type: 'text-delta', text: delta })
      }
      const outcome = {
        status: 'completed',
        executionId: input.executionId,
        sourceSessionId: input.source.sessionId,
        text,
      } as const
      await publish('state', { kind: 'done', status: 'completed' })
      return outcome
    } catch (error) {
      if (signal.aborted) {
        const outcome = {
          status: 'aborted',
          executionId: input.executionId,
          sourceSessionId: input.source.sessionId,
        } as const
        await publish('state', { kind: 'aborted', status: 'aborted' })
        return outcome
      }
      await publish('state', {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      this.executions.delete(input.executionId)
    }
  }

  public abort(input: unknown): { aborted: boolean; executionId: string } {
    const record = requireRecord(input, 'Agent abort input must be an object.')
    const executionId = requireNonBlankString(record.executionId, 'executionId is required.')
    const execution = this.executions.get(executionId)
    execution?.abort(new AppError('EXECUTION_ABORTED', 'Workbench Agent run aborted.'))
    return { aborted: execution !== undefined, executionId }
  }

  public dispose(): void {
    for (const execution of this.executions.values()) execution.abort()
    this.executions.clear()
  }

  private createTools(
    bridge: VelarosWorkspaceBridge,
    input: WorkbenchAgentExecuteInput
  ): ToolSet {
    const tools: ToolSet = Object.fromEntries(bridge.tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: definition.schema,
        execute: (toolInput) => definition.execute(toolInput),
      }),
    ]))
    const withBrowserSession = <T extends object>(
      value: T
    ): T & { agentSessionId: string; browserSessionId: string } => ({
      ...value,
      agentSessionId: input.source.sessionId,
      browserSessionId: input.browserSessionId,
    })
    tools.browser_open = tool({
      description: 'Create or open the Agent-linked browser session at a URL.',
      inputSchema: z.object({ url: z.string().min(1) }),
      execute: ({ url }) => this.browser.open({
        agentSessionId: input.source.sessionId,
        browserSessionId: input.browserSessionId,
        projectRoot: input.projectRoot,
        url,
      }),
    })
    tools.browser_navigate = tool({
      description: 'Navigate the Agent-linked browser session.',
      inputSchema: z.object({
        action: z.enum(['back', 'forward', 'reload', 'goto']),
        url: z.string().optional(),
      }),
      execute: (toolInput) => this.browser.navigate(withBrowserSession(toolInput)),
    })
    tools.browser_inspect = tool({
      description: 'Inspect the current Agent-linked page structure and text.',
      inputSchema: z.object({}),
      execute: (toolInput) => this.browser.inspect(withBrowserSession(toolInput)),
    })
    tools.browser_type = tool({
      description: 'Type text into the focused page element.',
      inputSchema: z.object({ text: z.string() }),
      execute: (toolInput) => this.browser.input(withBrowserSession(toolInput)),
    })
    tools.browser_select = tool({
      description: 'Capture one page element as a typed Browser selection.',
      inputSchema: z.object({ selector: z.string().min(1) }),
      execute: (toolInput) => this.browser.selection(withBrowserSession(toolInput)),
    })
    return tools
  }
}

export interface WorkbenchStandaloneKernelRuntimeOptions {
  kernelVersion: string
  workspace: WorkbenchWorkspaceCapabilityProvider
  isWorkspaceRootAllowed: (projectRoot: string) => boolean
  browserRuntime?: ElectronBrowserRuntime
  modelRuntime?: ModelRuntimeComposition
}

export class WorkbenchStandaloneKernelRuntime {
  private readonly host: KernelModuleHost
  private readonly service: KernelService
  private readonly daemon: KernelLocalDaemon
  private readonly modelRuntime: ModelRuntimeComposition
  private readonly browser: WorkbenchBrowserController
  private readonly agent: WorkbenchAgentCapabilityRuntime
  private descriptor?: KernelDaemonEndpointDescriptor
  private disposed = false

  public constructor(options: WorkbenchStandaloneKernelRuntimeOptions) {
    this.modelRuntime = options.modelRuntime ?? createModelRuntimeComposition()
    this.browser = new WorkbenchBrowserController(
      options.browserRuntime ?? new ElectronBrowserRuntime(),
      options.isWorkspaceRootAllowed
    )
    this.agent = new WorkbenchAgentCapabilityRuntime(
      this.modelRuntime,
      options.workspace,
      this.browser,
      options.isWorkspaceRootAllowed
    )
    const workspaceResolver: WorkspaceBridgeResolver = {
      resolveBridge: (scope, signal) => {
        signal.throwIfAborted()
        if (
          scope?.ownerModuleId !== WorkbenchWorkspaceScopeOwner
          || scope.kind !== 'project'
          || !scope.id
          || !options.isWorkspaceRootAllowed(scope.id)
        ) {
          throw new AppError('PERMISSION', 'Workbench Workspace scope is invalid.')
        }
        return options.workspace.resolveBridge(scope.id)
      },
    }
    this.host = new KernelModuleHost({
      apiVersion: 1,
      permissionBroker: new WorkbenchKernelPermissionBroker(),
    })
    this.host.registerModules([
      createModelKernelModule({ registry: this.modelRuntime.modelAdapterRegistry }),
      createWorkspaceKernelModule({ resolver: workspaceResolver }),
      createBrowserKernelModule({ runtime: this.browser.runtime }),
      createAgentKernelModule({ runtime: this.agent }),
    ])
    this.service = new KernelService({
      host: this.host,
      kernelVersion: options.kernelVersion,
    })
    this.daemon = new KernelLocalDaemon({ service: this.service })
  }

  public async start(): Promise<KernelDaemonEndpointDescriptor> {
    if (this.disposed) throw new Error('Disposed Workbench Kernel cannot start.')
    if (this.descriptor) return this.descriptor
    await this.service.start()
    try {
      this.descriptor = await this.daemon.start()
      return this.descriptor
    } catch (error) {
      if (error instanceof KernelDaemonError && error.code === 'DAEMON_ALREADY_RUNNING') {
        await this.dispose()
      }
      throw error
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.descriptor = undefined
    this.agent.dispose()
    this.browser.closeAll()
    await this.daemon.dispose()
    await this.service.dispose()
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION', message)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION', message)
  return value
}

function requireNonBlankString(value: unknown, message: string): string {
  const result = requireString(value, message).trim()
  if (!result) throw new AppError('VALIDATION', message)
  return result
}

function requireBoundedIdentifier(
  value: unknown,
  label: string,
  maxLength = 512
): string {
  const result = requireNonBlankString(value, `${label} is required.`)
  if (result !== value || result.length > maxLength) {
    throw new AppError('VALIDATION', `${label} is invalid.`)
  }
  return result
}

export {
  AgentExecutionEventType,
  WorkbenchWorkspaceScopeOwner,
}
