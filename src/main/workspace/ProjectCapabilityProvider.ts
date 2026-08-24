import { isAbsolute, resolve } from 'node:path'

import { defaultDenyApprovalPort } from '@velaros-ai/agent/tool-contract'
import {
  createProjectCodeQuery,
  type ProjectCodeIndexApi,
} from '@velaros-ai/development/runtime'
import {
  executeAgentProjectRead,
  type ProjectToolContext,
  projectTools,
} from '@velaros-ai/project/agent'
import type {
  ProjectCommandResult,
  ProjectMutationAuthorizationInput,
  ProjectRunCommandOptions,
} from '@velaros-ai/project/contracts'
import { isPathInsideProjectRoot } from '@velaros-ai/project/files'
import {
  createProjectKernel,
  type ProjectKernel,
} from '@velaros-ai/project/runtime'

import type { WorkbenchGetCodeGraphRequest } from '../../shared/contracts'
import type { WorkbenchWorkspaceInvokeRequest } from '../../shared/workbenchWorkspace'
import { WorkbenchCodeGraphResource } from '../resources/WorkbenchCodeGraphResource'

import { CommandHelper } from './CommandHelper'
import { CommandRunner } from './CommandRunner'
import { PathResolver } from './PathResolver'

interface WorkbenchProjectToolDefinition {
  name: string
  category: string
  role: string
  description: string
  permissions: readonly string[]
  schema: {
    safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown }
  }
  isConcurrencySafe?: (input: never) => boolean
  execute(input: unknown, toolContext: unknown): Promise<unknown>
}

interface WorkbenchProjectCapability {
  readonly kernel: ProjectKernel
  readonly tools: readonly WorkbenchProjectToolDefinition[]
}

interface WorkbenchProjectCapabilityProvider {
  invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown>
  resolveProject(projectRoot: string): Promise<WorkbenchProjectCapability>
  dispose(): Promise<void>
}

interface ProjectCapabilityProviderOptions {
  createKernel?: (projectRoot: string) => Promise<ProjectKernel>
  codeGraphResource?: WorkbenchCodeGraphResource
}

const unavailableWorkbenchCodeIndex: ProjectCodeIndexApi = {
  isAvailable: () => false,
  query: () => Promise.reject(new Error('Workbench CodeGraph agent query adapter is unavailable.')),
}

const workbenchProjectCodeQuery = createProjectCodeQuery(unavailableWorkbenchCodeIndex)

/**
 * Workbench 的 Project 领域适配器。
 *
 * Project 包拥有根目录约束、文件读写、事务和 Agent 工具；Workbench 只负责把产品 IPC、
 * 命令执行器与当前运行信号装配到该领域，不复制 Project 实现。
 */
class ProjectCapabilityProvider implements WorkbenchProjectCapabilityProvider {
  private readonly projects = new Map<string, Promise<WorkbenchProjectCapability>>()
  private readonly createKernel: (projectRoot: string) => Promise<ProjectKernel>
  private readonly commandRunner = new CommandRunner(new PathResolver(), new CommandHelper())
  private readonly codeGraphResource: WorkbenchCodeGraphResource

  public constructor(options: ProjectCapabilityProviderOptions = {}) {
    this.createKernel = options.createKernel ?? (async (projectRoot) =>
      createProjectKernel({ root: projectRoot }))
    this.codeGraphResource = options.codeGraphResource ?? new WorkbenchCodeGraphResource()
  }

  public async invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown> {
    if (request.operation === 'resource:codegraph-status') return this.codeGraphResource.describe()

    const project = await this.resolveProject(request.projectRoot)
    const input = request.input as never

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
        return this.codeGraphResource.indexProject(project.kernel.root)
      case 'project:codegraph-graph':
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
      .then((kernel) => ({
        kernel,
        tools: this.bindProjectTools(root, kernel),
      }))
      .catch((error) => {
        this.projects.delete(root)
        throw error
      })
    this.projects.set(root, created)
    return created
  }

  public async dispose(): Promise<void> {
    this.projects.clear()
  }

  private bindProjectTools(
    projectRoot: string,
    kernel: ProjectKernel
  ): readonly WorkbenchProjectToolDefinition[] {
    return Object.values(projectTools).map((tool) => ({
      name: tool.name,
      category: tool.category,
      role: tool.role,
      description: tool.description,
      permissions: tool.permissions,
      schema: tool.schema,
      isConcurrencySafe: tool.isConcurrencySafe,
      execute: (input, toolContext) =>
        Promise.resolve(tool.execute(
          input as never,
          this.createProjectToolContext(projectRoot, kernel, toolContext)
        )),
    }))
  }

  private createProjectToolContext(
    projectRoot: string,
    kernel: ProjectKernel,
    toolContext: unknown
  ): ProjectToolContext {
    let activeDirectory = projectRoot
    const abortSignal = readAbortSignal(toolContext) ?? new AbortController().signal

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
        runWithApproval: (action) => action(),
        prepareMutation: async (input) =>
          buildApprovedMutation(projectRoot, activeDirectory, input),
        queryCode: workbenchProjectCodeQuery,
        runCommand: (command, options, allowDangerous, signal) =>
          this.runProjectCommand(
            projectRoot,
            activeDirectory,
            command,
            options,
            allowDangerous,
            signal ?? abortSignal
          ),
      },
      system: {
        canStartBackgroundCommands: () => false,
      },
      approval: defaultDenyApprovalPort,
    }
  }

  private async runProjectCommand(
    projectRoot: string,
    activeDirectory: string,
    command: string,
    options: ProjectRunCommandOptions = {},
    _allowDangerous = false,
    abortSignal?: AbortSignal
  ): Promise<ProjectCommandResult> {
    abortSignal?.throwIfAborted()
    if (options.background) {
      throw new Error('Workbench Project 不提供后台命令执行。')
    }

    const cwd = resolveInsideProject(projectRoot, activeDirectory, options.cwd ?? '.')
    const result = await this.commandRunner.runCommand({
      projectRoot,
      command,
      cwd,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
    })
    abortSignal?.throwIfAborted()

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
        issues: result.success ? [] : [result.stderr || `命令退出码：${result.exitCode}`],
      },
    }
  }
}

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
    throw new Error('Project path escapes the selected project root.')
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
    ...(centerPath === undefined ? {} : { centerPath }),
    ...(depth === undefined ? {} : { depth }),
    ...(maxNodes === undefined ? {} : { maxNodes }),
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
