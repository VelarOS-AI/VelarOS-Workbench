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
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
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
  createModelRuntimeComposition,
  type ModelRuntimeComposition,
} from '@velaros-ai/model-runtime'
import {
  createWorkspaceKernelModule,
  type VelarosWorkspaceBridge,
  type WorkspaceBridgeResolver,
} from '@velaros-ai/workspace'

import type { WorkbenchWorkspaceCapabilityProvider } from '../workspace/PublishedWorkspaceCapabilityProvider'

import { WorkbenchBrowserController } from './WorkbenchBrowserController'

const WorkbenchKernelVersion = '0.3.0'
const WorkbenchWorkspaceScopeOwner = 'velaros.workbench.workspace-scope'
const AgentExecutionEventType = 'velaros.agent.execution'

const ModelProfilesCapability = createCapabilityToken(
  'velaros.workbench.model-profiles'
)
const BrowserControlCapability = createCapabilityToken(
  'velaros.workbench.browser-control'
)
const AgentControlCapability = createCapabilityToken(
  'velaros.workbench.agent-control'
)

const grantedPermissions = new Set([
  'agent:execute',
  'browser:control',
  'fs:read',
  'fs:write',
  'model:configure',
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

interface WorkbenchModelProfile {
  id: string
  provider: string
  model: string
  apiKey: string
  baseURL: string
}

class WorkbenchModelProfileStore {
  private readonly profiles = new Map<string, WorkbenchModelProfile>()

  public configure(input: unknown): Omit<WorkbenchModelProfile, 'apiKey'> {
    const record = requireRecord(input, 'Model profile must be an object.')
    const profile: WorkbenchModelProfile = {
      id: requireNonBlankString(record.profileId, 'profileId is required.'),
      provider: requireNonBlankString(record.provider, 'provider is required.'),
      model: requireNonBlankString(record.model, 'model is required.'),
      apiKey: requireString(record.apiKey, 'apiKey must be a string.'),
      baseURL: requireString(record.baseURL, 'baseURL must be a string.').trim(),
    }
    this.profiles.set(profile.id, profile)
    return {
      id: profile.id,
      provider: profile.provider,
      model: profile.model,
      baseURL: profile.baseURL,
    }
  }

  public require(profileId: string): WorkbenchModelProfile {
    const profile = this.profiles.get(profileId)
    if (!profile) {
      throw new AppError(
        'NOT_FOUND',
        `Workbench model profile "${profileId}" is not configured.`
      )
    }
    return profile
  }

  public clear(): void {
    this.profiles.clear()
  }
}

interface WorkbenchAgentExecuteInput {
  protocolVersion: 1
  executionId: string
  sourceSessionId: string
  sessionCorrelationId: string
  projectRoot: string
  modelProfileId: string
  browserSessionId: string
  messages: ModelMessage[]
}

function parseAgentExecuteInput(
  input: unknown,
  scope: ScopeRef | undefined
): WorkbenchAgentExecuteInput {
  const record = requireRecord(input, 'Workbench Agent input must be an object.')
  const allowedKeys = new Set([
    'protocolVersion',
    'executionId',
    'sourceSessionId',
    'sessionCorrelationId',
    'projectRoot',
    'modelProfileId',
    'browserSessionId',
    'messages',
  ])
  if (Object.keys(record).some((key) => !allowedKeys.has(key)) || 'config' in record) {
    throw new AppError(
      'VALIDATION',
      'Workbench Agent input contains an unsupported legacy or unknown field.'
    )
  }
  const projectRoot = requireNonBlankString(record.projectRoot, 'projectRoot is required.')
  if (
    record.protocolVersion !== 1
    || scope?.ownerModuleId !== WorkbenchWorkspaceScopeOwner
    || scope.kind !== 'project'
    || scope.id !== projectRoot
    || !Array.isArray(record.messages)
  ) {
    throw new AppError('VALIDATION', 'Workbench Agent execution scope or input is invalid.')
  }
  return {
    protocolVersion: 1,
    executionId: requireNonBlankString(record.executionId, 'executionId is required.'),
    sourceSessionId: requireNonBlankString(record.sourceSessionId, 'sourceSessionId is required.'),
    sessionCorrelationId: requireNonBlankString(
      record.sessionCorrelationId,
      'sessionCorrelationId is required.'
    ),
    projectRoot,
    modelProfileId: requireNonBlankString(
      record.modelProfileId,
      'modelProfileId is required.'
    ),
    browserSessionId: requireNonBlankString(
      record.browserSessionId,
      'browserSessionId is required.'
    ),
    messages: record.messages as ModelMessage[],
  }
}

class WorkbenchAgentCapabilityRuntime implements AgentCapabilityRuntime {
  private readonly requestPort = new AiSdkAgentModelRequestPort()
  private readonly executions = new Map<string, AbortController>()

  public constructor(
    private readonly profiles: WorkbenchModelProfileStore,
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
    const publish = (type: string, payload: Record<string, unknown> = {}) =>
      context.publish(AgentExecutionEventType, {
        executionId: input.executionId,
        sourceSessionId: input.sourceSessionId,
        sessionCorrelationId: input.sessionCorrelationId,
        type,
        ...payload,
      })

    try {
      await publish('start', {
        projectRoot: input.projectRoot,
        browserSessionId: input.browserSessionId,
      })
      const profile = this.profiles.require(input.modelProfileId)
      const resolved = await this.models.agentModelRuntime.resolveRoleRuntime(
        {
          provider: profile.provider,
          model: profile.model,
          apiKey: '',
          baseURL: '',
        },
        {
          providerRuntimeConfigs: [{
            provider: profile.provider,
            enabled: true,
            apiKey: profile.apiKey,
            baseURL: profile.baseURL,
            defaultModel: profile.model,
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
            sessionId: input.sourceSessionId,
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
        await publish('text-delta', { text: delta })
      }
      const outcome = {
        status: 'completed',
        executionId: input.executionId,
        sourceSessionId: input.sourceSessionId,
        sessionCorrelationId: input.sessionCorrelationId,
        text,
      } as const
      await publish('done', outcome)
      return outcome
    } catch (error) {
      if (signal.aborted) {
        const outcome = {
          status: 'aborted',
          executionId: input.executionId,
          sourceSessionId: input.sourceSessionId,
          sessionCorrelationId: input.sessionCorrelationId,
        } as const
        await publish('aborted', outcome)
        return outcome
      }
      await publish('error', {
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
      agentSessionId: input.sourceSessionId,
      browserSessionId: input.browserSessionId,
    })
    tools.browser_open = tool({
      description: 'Create or open the Agent-linked browser session at a URL.',
      inputSchema: z.object({ url: z.string().min(1) }),
      execute: ({ url }) => this.browser.open({
        agentSessionId: input.sourceSessionId,
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

function createModelProfilesModule(profiles: WorkbenchModelProfileStore) {
  return defineKernelModule({
    manifest: {
      id: 'velaros.workbench.model-profiles',
      version: '0.3.0',
      apiVersion: 1,
      provides: [ModelProfilesCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['model:configure'],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(
        ModelProfilesCapability,
        createKernelCallableCapability({
          configure: {
            metadata: {
              permissions: ['model:configure'],
              reason: 'Configure a Workbench-owned Model Runtime profile.',
            },
            invoke: (_scope, input) => profiles.configure(input),
          },
        })
      )
    },
  })
}

function createBrowserControlModule(browser: WorkbenchBrowserController) {
  const operation = (
    reason: string,
    invoke: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>
  ) => ({
    metadata: { permissions: ['browser:control'], reason },
    invoke: (_scope: ScopeRef | undefined, input: unknown, signal: AbortSignal) =>
      invoke(input, signal),
  })
  return defineKernelModule({
    manifest: {
      id: 'velaros.workbench.browser-control',
      version: '0.3.0',
      apiVersion: 1,
      provides: [BrowserControlCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['browser:control'],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(
        BrowserControlCapability,
        createKernelCallableCapability({
          create: operation('Create an Agent-linked browser session.', (input, signal) =>
            browser.create(input, signal)),
          open: operation('Open a URL in an Agent-linked browser session.', (input, signal) =>
            browser.open(input, signal)),
          navigate: operation('Navigate an Agent-linked browser session.', (input, signal) =>
            browser.navigate(input, signal)),
          inspect: operation('Inspect an Agent-linked browser session.', (input, signal) =>
            browser.inspect(input, signal)),
          input: operation('Type in an Agent-linked browser session.', (input, signal) =>
            browser.input(input, signal)),
          selection: operation('Capture a Browser element selection.', (input, signal) =>
            browser.selection(input, signal)),
          close: operation('Close an Agent-linked browser session.', (input) =>
            browser.close(input)),
          close_all: operation('Close every Agent-linked browser session.', () =>
            browser.closeAll()),
        })
      )
    },
  })
}

function createAgentControlModule(agent: WorkbenchAgentCapabilityRuntime) {
  return defineKernelModule({
    manifest: {
      id: 'velaros.workbench.agent-control',
      version: '0.3.0',
      apiVersion: 1,
      provides: [AgentControlCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['agent:execute'],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(
        AgentControlCapability,
        createKernelCallableCapability({
          abort: {
            metadata: {
              permissions: ['agent:execute'],
              reason: 'Abort one Workbench Agent execution.',
            },
            invoke: (_scope, input) => agent.abort(input),
          },
        })
      )
    },
  })
}

export interface WorkbenchStandaloneKernelRuntimeOptions {
  workspace: WorkbenchWorkspaceCapabilityProvider
  isWorkspaceRootAllowed: (projectRoot: string) => boolean
  browserRuntime?: ElectronBrowserRuntime
  modelRuntime?: ModelRuntimeComposition
}

export class WorkbenchStandaloneKernelRuntime {
  private readonly host: KernelModuleHost
  private readonly service: KernelService
  private readonly daemon: KernelLocalDaemon
  private readonly profiles = new WorkbenchModelProfileStore()
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
      this.profiles,
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
      createModelProfilesModule(this.profiles),
      createBrowserControlModule(this.browser),
      createAgentControlModule(this.agent),
      createAgentKernelModule({ runtime: this.agent }),
    ])
    this.service = new KernelService({
      host: this.host,
      kernelVersion: WorkbenchKernelVersion,
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
    this.profiles.clear()
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

export {
  AgentExecutionEventType,
  WorkbenchWorkspaceScopeOwner,
}
