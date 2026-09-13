import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import type { ToolCategoryDefinition, ToolCategoryId } from '@velaros-ai/agent/protocol'
import {
  type ApprovalPort,
  createApprovalOperationKey,
  defaultDenyApprovalPort,
} from '@velaros-ai/agent/tool-contract'
import {
  createProjectCodeQuery,
  type ProjectCodeIndexApi,
} from '@velaros-ai/development/runtime'
import {
  executeAgentProjectRead,
  type ProjectToolContext,
  projectTools,
} from '@velaros-ai/project/agent'
import {
  createProjectBundledModDefinition,
  installProjectApprovalProvider,
  ProjectModId,
  ProjectSpaceId,
  ProjectToolCategories,
  withProjectApproval,
} from '@velaros-ai/project/composition'
import {
  ProjectCodeLanguageActions,
  type ProjectCodeQuery,
  ProjectCodeQuerySchema,
  type ProjectCommandResult,
  type ProjectMutationAuthorizationInput,
  type ProjectRunCommandOptions,
  ProjectToolNames,
} from '@velaros-ai/project/contracts'
import { buildBackgroundCommandConfirmationMessage } from '@velaros-ai/project/execution'
import { isPathInsideProjectRoot } from '@velaros-ai/project/files'
import {
  createProjectKernel,
  ProjectError,
  type ProjectKernel,
} from '@velaros-ai/project/runtime'

import type { WorkbenchGetCodeGraphRequest } from '../../shared/contracts'
import type { WorkbenchWorkspaceInvokeRequest } from '../../shared/workbenchWorkspace'
import type { WorkbenchAgentToolDefinition } from '../agent/WorkbenchAgentToolRegistry'
import { WorkbenchCodeGraphResource } from '../resources/WorkbenchCodeGraphResource'

import {
  readReportedChangedFiles,
  readWorkbenchAgentProjectActivity,
  type WorkbenchAgentProjectActivityPort,
} from './git/WorkbenchChatRunAttribution'
import { type WorkbenchVelarLogicGraphService } from './language/WorkbenchVelarLogicGraphService'
import {
  analyzeWorkbenchCommandExecution,
  createDangerousCommandApprovalOptions,
} from './CommandExecutionPolicy'
import { CommandHelper } from './CommandHelper'
import { CommandRunner } from './CommandRunner'
import { PathResolver } from './PathResolver'

function createAvailableCodeQuerySchema(withIndex: boolean) {
  const actions = new Set<string>(ProjectCodeLanguageActions)
  // These graph contracts have no matching Workbench backend implementation yet.
  const unsupported = new Set(['trace', 'find_dead_code', 'type_hierarchy'])
  const [first, ...remaining] = ProjectCodeQuerySchema.options.filter((schema) =>
    actions.has(schema.shape.action.value)
      || (withIndex && !unsupported.has(schema.shape.action.value)))
  if (!first) throw new Error('Project language query schema has no actions')
  return z.discriminatedUnion('action', [first, ...remaining])
}
const LanguageCodeQuerySchema = createAvailableCodeQuerySchema(false)
const IndexedCodeQuerySchema = createAvailableCodeQuerySchema(true)

type WorkbenchProjectToolDefinition = WorkbenchAgentToolDefinition

interface WorkbenchProjectCapability {
  readonly kernel: ProjectKernel
  readonly tools: readonly WorkbenchProjectToolDefinition[]
  readonly categoryDefinitions: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>>
  readonly enabledCategoryIds: readonly ToolCategoryId[]
  readonly residentCategoryIds: readonly ToolCategoryId[]
  readonly initialVisibleToolNames: readonly string[]
}

interface WorkbenchProjectCapabilityProvider {
  invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown>
  resolveProject(projectRoot: string): Promise<WorkbenchProjectCapability>
  dispose(): Promise<void>
}

interface ProjectCapabilityProviderOptions {
  createKernel?: (projectRoot: string) => Promise<ProjectKernel>
  codeGraphResource?: WorkbenchCodeGraphResource
  velarLogicGraph?: WorkbenchVelarLogicGraphService
}

/**
 * Workbench 的 Project 领域适配器。
 *
 * Project 包拥有根目录约束、文件读写、事务和 Agent 工具；Workbench 只负责把产品 IPC、
 * 命令执行器与当前运行信号装配到该领域，不复制 Project 实现。
 */
class ProjectCapabilityProvider implements WorkbenchProjectCapabilityProvider {
  private readonly projects = new Map<string, Promise<WorkbenchProjectCapability>>()
  private readonly createKernel: (projectRoot: string) => Promise<ProjectKernel>
  private readonly commandHelper = new CommandHelper()
  private readonly commandRunner = new CommandRunner(new PathResolver(), this.commandHelper)
  private readonly codeGraphResource: WorkbenchCodeGraphResource
  private readonly velarLogicGraph?: WorkbenchVelarLogicGraphService

  public constructor(options: ProjectCapabilityProviderOptions = {}) {
    this.createKernel = options.createKernel ?? (async (projectRoot) =>
      createProjectKernel({ root: projectRoot }))
    this.codeGraphResource = options.codeGraphResource ?? new WorkbenchCodeGraphResource()
    this.velarLogicGraph = options.velarLogicGraph
  }

  public async invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown> {
    if (request.operation === 'resource:codegraph-status') return this.codeGraphResource.describe()

    const project = await this.resolveProject(request.projectRoot)
    const input = request.input as never

    // 这条 IPC 是**用户自己点的**（编辑器应用改动、回滚、运行校验），不是模型动作：它没有确认卡
    // 可弹，弹了也是问用户「你刚点的这个要不要执行」。因此整条路径进一个直接放行的审批作用域。
    //
    // 不进作用域会更糟：内核的 approval provider 读不到 ALS store 时按 `false` 收敛，
    // 高风险补丁会被**静默拒绝**——用户点了应用，什么也没发生，也没有任何解释。
    return withProjectApproval(
      { approval: userInitiatedApprovalPort, abortSignal: new AbortController().signal },
      () => this.invokeProjectOperation(project, request, input)
    )
  }

  private async invokeProjectOperation(
    project: WorkbenchProjectCapability,
    request: WorkbenchWorkspaceInvokeRequest,
    input: never
  ): Promise<unknown> {
    switch (request.operation) {
      case 'project:status':
        return project.kernel.status()
      case 'project:read':
        return executeAgentProjectRead(project.kernel, input, {
          rootPath: project.kernel.root,
        })
      case 'project:stat':
        return project.kernel.stat(input)
      case 'project:list':
        return project.kernel.listFiles(input)
      case 'project:search':
        return project.kernel.search(input)
      case 'project:symbols':
        return project.kernel.listSymbols(readRequiredPath(request.input))
      case 'project:resolve-target':
        return project.kernel.resolveTarget(input)
      case 'project:build-evidence':
        return project.kernel.buildEvidencePack(input)
      case 'project:diff':
        return project.kernel.diff(input)
      case 'project:prepare-edit':
        return project.kernel.prepareEdit(input)
      case 'project:amend-edit':
        return project.kernel.amendEdit(input)
      case 'project:apply-edit':
        return project.kernel.applyEdit(input)
      case 'project:validate':
        return project.kernel.validate(input)
      case 'project:rollback':
        return project.kernel.rollback(input)
      case 'project:run-batch':
        return project.kernel.runBatch(input)
      case 'project:codegraph-index':
        if (this.velarLogicGraph?.isProject(project.kernel.root)) {
          throw new Error('VelarScript projects use the compiler-owned structure graph, not CodeGraph.')
        }
        return this.codeGraphResource.indexProject(project.kernel.root)
      case 'project:codegraph-graph':
        if (this.velarLogicGraph?.isProject(project.kernel.root)) {
          throw new Error('VelarScript projects use the compiler-owned structure graph, not CodeGraph.')
        }
        return this.codeGraphResource.getGraph(
          readCodeGraphRequest(project.kernel.root, request.input)
        )
    }
  }

  public resolveProject(projectRoot: string): Promise<WorkbenchProjectCapability> {
    const root = normalizeProjectRoot(projectRoot)
    const existing = this.projects.get(root)
    if (existing) return existing

    const created = this.createKernel(root)
      .then((kernel) => {
        // 项目内核的高风险补丁要走人审：不装 approval provider，`decide` 会直接抛
        // 「需要审批，但宿主没有提供审批通道」。实际的征询由当轮 ApprovalPort 经
        // withProjectApproval 的动态作用域注入（见 createProjectToolContext）。
        installProjectApprovalProvider(kernel)
        return kernel
      })
      .then((kernel) => ({
        kernel,
        tools: this.bindProjectTools(root, kernel),
        categoryDefinitions: ProjectToolCategories,
        enabledCategoryIds: ProjectCategoryIds,
        residentCategoryIds: ProjectCategoryIds,
        initialVisibleToolNames: ProjectInitialVisibleToolNames,
      }))
      .catch((error) => {
        this.projects.delete(root)
        throw error
      })
    this.projects.set(root, created)
    return created
  }

  public async dispose(): Promise<void> {
    for (const root of this.projects.keys()) this.velarLogicGraph?.clear(root)
    this.projects.clear()
  }

  private bindProjectTools(
    projectRoot: string,
    kernel: ProjectKernel
  ): readonly WorkbenchProjectToolDefinition[] {
    const hasIndex = (): boolean => this.codeGraphResource.describe().available
      && !this.velarLogicGraph?.isProject(projectRoot)
    return Object.values(projectTools).map((tool) => ({
      name: tool.name,
      categoryId: tool.category,
      role: tool.role,
      get description() {
        return tool.name === ProjectToolNames.queryCode && !hasIndex()
          ? `查询项目代码。当前可用 action：${ProjectCodeLanguageActions.join('、')}。先用 find_symbols 定位声明，再按任务查询引用、导入、导出或诊断。`
          : tool.description
      },
      permissions: [...tool.permissions],
      capabilities: tool.capabilities,
      requiredModelInputModalities: tool.requiredModelInputModalities,
      exposure: tool.exposure,
      usageSkillId: tool.usageSkillId,
      outputInline: tool.outputInline,
      hideWhenUnavailable: tool.hideWhenUnavailable,
      providerId: ProjectModId,
      get schema() {
        return (tool.name === ProjectToolNames.queryCode
          ? hasIndex() ? IndexedCodeQuerySchema : LanguageCodeQuerySchema
          : tool.schema) as WorkbenchProjectToolDefinition['schema']
      },
      surfaces: bindProjectToolSurfaces(tool.surfaces, (toolContext) =>
        this.createProjectToolContext(projectRoot, kernel, toolContext)),
      isAvailable: tool.isAvailable
        ? (toolContext) => tool.isAvailable?.(
            this.createProjectToolContext(projectRoot, kernel, toolContext)
          ) ?? true
        : undefined,
      unavailableReason: tool.unavailableReason
        ? (toolContext) => tool.unavailableReason?.(
            this.createProjectToolContext(projectRoot, kernel, toolContext)
          )
        : undefined,
      isConcurrencySafe: tool.isConcurrencySafe as WorkbenchProjectToolDefinition['isConcurrencySafe'],
      execute: (input, toolContext) => {
        const run = (): Promise<unknown> => Promise.resolve(tool.execute(
          input as never,
          this.createProjectToolContext(projectRoot, kernel, toolContext)
        ))
        const activity = ProjectFileWriteToolNames.has(tool.name)
          ? readWorkbenchAgentProjectActivity(toolContext)
          : undefined
        return activity ? reportProjectFileWrite(activity, run) : run()
      },
    }))
  }

  private createProjectToolContext(
    projectRoot: string,
    kernel: ProjectKernel,
    toolContext: unknown
  ): ProjectToolContext {
    let activeDirectory = projectRoot
    const abortSignal = readAbortSignal(toolContext) ?? new AbortController().signal
    // 审批端口由**当轮**执行注入：provider 是每项目单例，端口却绑定单次运行的会话与事件流。
    // 读不到就退回设计式拒绝，模型收到「没有审批通道」而不是静默放行。
    const approval = readApprovalPort(toolContext) ?? defaultDenyApprovalPort
    const activity = readWorkbenchAgentProjectActivity(toolContext)

    return {
      abortSignal,
      project: {
        getRootPath: () => projectRoot,
        kernel: async () => kernel,
        runInDirectory: async (path, action) => {
          const previousDirectory = activeDirectory
          activeDirectory = resolveInsideProject(projectRoot, activeDirectory, path)
          try {
            return await action()
          } finally {
            activeDirectory = previousDirectory
          }
        },
        runWithApproval: (action) => withProjectApproval({ approval, abortSignal }, action),
        prepareMutation: async (input) =>
          buildApprovedMutation(projectRoot, activeDirectory, input),
        queryCode: this.projectCodeQuery(projectRoot),
        // 平台合同只把宿主返回值声明成命令结果，但 `project:run` 把它原样交给模型，自己拒绝时也返回
        // 同形的 skipped；宿主补问被拒时同样返回 skipped，模型和界面读到的两种拒绝才是一个样子。
        runCommand: (command, options, allowDangerous, signal) =>
          this.runProjectCommand(
            { projectRoot, activeDirectory, approval, abortSignal: signal ?? abortSignal, activity },
            command,
            options,
            allowDangerous
          ) as Promise<ProjectCommandResult>,
      },
      system: {
        canStartBackgroundCommands: () => false,
      },
      approval,
    }
  }

  private projectCodeQuery(projectRoot: string): (
    input: ProjectCodeQuery,
    context: ProjectToolContext
  ) => Promise<unknown> {
    const velarProject = this.velarLogicGraph?.isProject(projectRoot) === true
    const codeIndex: ProjectCodeIndexApi = {
      isAvailable: () => velarProject || this.codeGraphResource.describe().available,
      query: (input, context) => velarProject
        ? this.velarLogicGraph!.queryProjectCode(context.project.getRootPath(), input)
        : this.codeGraphResource.queryProjectCode(context.project.getRootPath(), input),
    }
    return createProjectCodeQuery(codeIndex)
  }

  /**
   * `project:run` 落到宿主的执行口。
   *
   * 平台判危险的命令它自己问过了，批准后带 `allowDangerous` 进来，这里不再问第二遍；平台放行、而
   * Workbench 补充判定为危险的（丢工作区改动的 Git 调用、递归删除目录、写到工作区外……）由这里经
   * 当轮审批端口补问一次，批准照常执行，拒绝返回与平台同形的 skipped 结果。
   */
  private async runProjectCommand(
    scope: ProjectCommandScope,
    command: string,
    options: ProjectRunCommandOptions = {},
    allowDangerous = false
  ): Promise<ProjectCommandResult | SkippedProjectCommand> {
    const { projectRoot, abortSignal } = scope
    abortSignal.throwIfAborted()
    if (options.background) {
      throw new Error('Workbench Project 不提供后台命令执行。')
    }

    const cwd = resolveInsideProject(projectRoot, scope.activeDirectory, options.cwd ?? '.')
    const plan = analyzeWorkbenchCommandExecution(command, projectRoot)
    if (plan.isDangerous && !allowDangerous) {
      const decision = await scope.approval.awaitConfirmationDecision(
        buildBackgroundCommandConfirmationMessage(command, plan, '当前项目', false),
        abortSignal,
        createDangerousCommandApprovalOptions('project-command:dangerous', {
          // 与平台同一个操作身份：同一条命令被拒过，换哪一层来问都记得。
          key: createApprovalOperationKey('shell-command', { command: command.trim(), cwd, background: false }),
          label: command,
          target: cwd,
        })
      )
      if (!decision.approved)
        return { approved: false, skipped: true, command, message: decision.message ?? '用户拒绝执行该危险命令。' }
    }

    // 走到这里的危险命令都已经有人批准过：平台那一问，或上面这一问。时间窗只框进程真正在跑的那段
    // （审批等待不算）：这段时间里项目里冒出来的改动算 Agent 命令的副作用。
    const endCommand = scope.activity?.beginCommand()
    const result = await this.commandRunner.runCommand({
      projectRoot,
      command,
      cwd,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
    }, undefined, abortSignal, plan.isDangerous).finally(() => endCommand?.())
    abortSignal.throwIfAborted()

    return {
      command: result.command,
      cwd: result.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      aborted: false,
      truncated: result.truncated,
      success: result.success,
      verification: {
        kind: 'unknown',
        status: result.timedOut ? 'timed-out' : result.success ? 'passed' : 'failed',
        issues: result.success ? [] : this.commandHelper.summarizeFailureOutput(result.stdout, result.stderr),
      },
    }
  }
}

/** 一次 `project:run` 落到宿主时的执行范围：根、当前目录，以及当轮的审批端口、取消信号与上报口。 */
interface ProjectCommandScope {
  projectRoot: string
  activeDirectory: string
  approval: ApprovalPort
  abortSignal: AbortSignal
  activity?: WorkbenchAgentProjectActivityPort
}

/** 会写文件的 Project 工具：结果里的 `changedFiles` 就是它改过的路径（相对项目根）。 */
const ProjectFileWriteToolNames: ReadonlySet<string> = new Set([
  ProjectToolNames.write,
  ProjectToolNames.edit,
  ProjectToolNames.rollback,
])

/** 写文件工具的起止与它报告改过的路径交给改动归属账本；失败的调用报空清单（内核会把半途的写入复原）。 */
async function reportProjectFileWrite(
  activity: WorkbenchAgentProjectActivityPort,
  run: () => Promise<unknown>
): Promise<unknown> {
  const finish = activity.beginFileWrite()
  let changedFiles: string[] = []
  try {
    const result = await run()
    changedFiles = readReportedChangedFiles(result)
    return result
  } finally {
    finish(changedFiles)
  }
}

/** 用户拒绝危险命令时交给模型的结果：与平台 `project:run` 自己拒绝时同形，命令没有执行，没有输出可报。 */
interface SkippedProjectCommand {
  approved: false
  skipped: true
  command: string
  message: string
}

const ProjectBundledModDefinition = createProjectBundledModDefinition()
const ProjectCategoryIds = Object.freeze(Object.keys(ProjectToolCategories))
// Project mod 只把主回路工具标成常驻，`project:rollback` 这类事故通道留给 `tooling:map` 按名换入。
// Workbench 没有 `tooling:map`：不常驻的工具模型永远拿不到（真机里 Agent 想回滚自己的改动却找不到入口），
// 所以这里让 Project 的全部工具首轮可见；多出的只是一条回滚工具的 schema。
const ProjectInitialVisibleToolNames = Object.freeze(
  ProjectBundledModDefinition.manifest.contributes.tools
    .filter((tool) => tool.availableInSpaces?.includes(ProjectSpaceId) === true)
    .map((tool) => tool.name)
)

function bindProjectToolSurfaces(
  surfaces: ProjectToolSurfaces | undefined,
  createContext: (toolContext: unknown) => ProjectToolContext
): WorkbenchProjectToolDefinition['surfaces'] {
  if (!surfaces) return undefined
  return Object.fromEntries(Object.entries(surfaces).flatMap(([profileId, surface]) =>
    surface
      ? [[
          profileId,
          {
            description: surface.description,
            schema: surface.schema as WorkbenchProjectToolDefinition['schema'],
            normalize: surface.normalize
              ? (input: unknown, toolContext: unknown) => surface.normalize?.(
                  input,
                  createContext(toolContext)
                )
              : undefined,
          },
        ]]
      : []))
}

type ProjectToolSurfaces = NonNullable<
  (typeof projectTools)[keyof typeof projectTools]['surfaces']
>

function normalizeProjectRoot(projectRoot: string): string {
  const trimmed = projectRoot.trim()
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new Error('Project projectRoot must be an absolute path.')
  }
  return resolve(trimmed)
}

function resolveInsideProject(
  projectRoot: string,
  activeDirectory: string,
  inputPath: string
): string {
  const resolvedPath = resolve(activeDirectory, inputPath)
  if (!isPathInsideProjectRoot(projectRoot, resolvedPath)) {
    throw new ProjectError(
      'SCOPE_VIOLATION',
      `工作目录超出当前项目：${inputPath}`,
      { projectRoot, activeDirectory, requestedPath: inputPath, resolvedPath },
      'cwd 只接受当前项目内的目录（相对路径或绝对路径）；省略 cwd 使用当前项目目录。如需操作其他项目，请先切换项目。',
    )
  }
  return resolvedPath
}

function buildApprovedMutation(
  projectRoot: string,
  activeDirectory: string,
  input: ProjectMutationAuthorizationInput
) {
  const rootPath = resolveInsideProject(
    projectRoot,
    activeDirectory,
    input.targetPath ?? input.cwd ?? '.'
  )
  return {
    approved: true,
    rootPath,
    switched: false,
    alreadyAuthorized: true,
    rejectionMessage: null,
    message: 'Project mutation is scoped to the selected project root.',
  }
}

function readAbortSignal(toolContext: unknown): AbortSignal | undefined {
  if (!toolContext || typeof toolContext !== 'object') return undefined
  const signal = (toolContext as { abortSignal?: unknown }).abortSignal
  return signal instanceof AbortSignal ? signal : undefined
}

/**
 * 用户主动操作的审批端口：一律放行。
 *
 * 它只挂在 IPC 路径上（见 {@link ProjectCapabilityProvider.invoke} 的注释）。模型动作走的是
 * 工具上下文里那个真端口，与本端口没有任何交叉——别把它当成「反正都放行」的通用兜底。
 */
const userInitiatedApprovalPort: ApprovalPort = {
  awaitConfirmation: async () => undefined,
  awaitConfirmationDecision: async () => ({
    approved: true,
    message: null,
    autoApproved: true,
  }),
}

/** 从宿主工具上下文里取当轮审批端口；形状不完整一律当缺席，绝不半个端口上场。 */
function readApprovalPort(toolContext: unknown): ApprovalPort | undefined {
  if (!toolContext || typeof toolContext !== 'object') return undefined
  const approval = (toolContext as { approval?: unknown }).approval
  if (!approval || typeof approval !== 'object') return undefined
  const port = approval as Partial<ApprovalPort>
  return typeof port.awaitConfirmation === 'function'
    && typeof port.awaitConfirmationDecision === 'function'
    ? approval as ApprovalPort
    : undefined
}

function readRequiredPath(input: unknown): string {
  if (!input || typeof input !== 'object') throw new Error('Project path is required.')
  const path = (input as { path?: unknown }).path
  if (typeof path !== 'string' || !path.trim()) throw new Error('Project path is required.')
  return path
}

function readCodeGraphRequest(
  projectRoot: string,
  input: unknown
): WorkbenchGetCodeGraphRequest {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  const mode = record['mode'] === 'local' ? 'local' : 'full'
  const centerPath = typeof record['centerPath'] === 'string'
    ? record['centerPath']
    : undefined
  const depth = typeof record['depth'] === 'number' && Number.isFinite(record['depth'])
    ? record['depth']
    : undefined
  const maxNodes = typeof record['maxNodes'] === 'number' && Number.isFinite(record['maxNodes'])
    ? record['maxNodes']
    : undefined

  return {
    projectRoot,
    mode,
    centerPath,
    depth,
    maxNodes,
  }
}

const WorkbenchProjectOperations = Object.freeze({
  status: 'project:status',
  read: 'project:read',
  stat: 'project:stat',
  list: 'project:list',
  search: 'project:search',
  symbols: 'project:symbols',
  resolveTarget: 'project:resolve-target',
  buildEvidence: 'project:build-evidence',
  diff: 'project:diff',
  prepareEdit: 'project:prepare-edit',
  amendEdit: 'project:amend-edit',
  applyEdit: 'project:apply-edit',
  validate: 'project:validate',
  rollback: 'project:rollback',
  runBatch: 'project:run-batch',
  codeGraphIndex: 'project:codegraph-index',
  codeGraphGraph: 'project:codegraph-graph',
} as const)

export { ProjectCapabilityProvider, WorkbenchProjectOperations }
export type {
  ProjectCapabilityProviderOptions,
  WorkbenchProjectCapability,
  WorkbenchProjectCapabilityProvider,
  WorkbenchProjectToolDefinition,
}
