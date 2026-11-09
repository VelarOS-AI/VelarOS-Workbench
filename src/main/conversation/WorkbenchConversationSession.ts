import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'

import type { RuntimeMetric, VelarosRuntime, VelarosSession } from '@velaros-ai/velaros'
import {
  createCapabilityModule,
  createNodeExecutionEnvironment,
  createRuntime,
} from '@velaros-ai/velaros'
import {
  type BrowserOperationContext,
  browserOperations,
  cdpOperations,
  createBrowserLoginGate,
  devtoolsOperations,
} from '@velaros-ai/velaros/browser'
import {
  VelarBrowserModule,
  VelarCdpModule,
  VelarDevtoolsModule,
} from '@velaros-ai/velaros/browser/contracts'
import {
  isArray,
  isBoolean,
  isNonBlankString,
  isPlainObject,
  isTrue,
} from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import type {
  ApprovalDecision,
  OperationContext,
  PreparedInvocation,
  ToolConfirmationDecisionOptions,
} from '@velaros-ai/velaros/kernel'
import { sessionsOperations } from '@velaros-ai/velaros/sessions'
import { VelarSessionsModule } from '@velaros-ai/velaros/sessions/contracts'
import { webOperations } from '@velaros-ai/velaros/web'
import { VelarWebModule } from '@velaros-ai/velaros/web/contracts'

import { workbenchMainText } from '../i18n/workbenchMainMessages'
import type { WorkbenchAgentProjectActivityPort } from '../workspace/git/WorkbenchChatRunAttribution'
import { isRelativePathInsideRoot } from '../workspace/PathContainmentHelper'

import { LoginConfirmation } from './ConversationInteractions'
import { createWorkbenchConsoleModule } from './WorkbenchConsoleModule'
import type {
  ConversationControlOptions,
  ConversationWorkspaceHandle,
  ConversationWorkspaceOptions,
} from './WorkbenchConversationTypes'
import { resolveWorkbenchNodeEnvironment } from './WorkbenchNodeRuntime'
import type { WorkbenchShellHostRegistryApi } from './WorkbenchShellHostRegistry'

/** 项目能力的写入由 Kernel 效果闸记录；标准 Node 进程由宿主单独记录。 */
const ProjectWritingModules: readonly string[] = ['velaros:project']
const ProjectCommitOperation = 'velaros:project.commit'

// 与 Desktop 共用不限累计用量的公开合同；模型窗口、取消和子任务期限仍独立生效。
const ModelUsageBudget = Object.freeze({
  modelCalls: Number.MAX_SAFE_INTEGER,
  modelTokens: Number.MAX_SAFE_INTEGER,
})
const WorkerRunTimeoutMs = 4 * 60 * 60 * 1000

export interface WorkbenchConversationSessionApi {
  open(options: ConversationWorkspaceOptions): Promise<ConversationWorkspaceHandle>
  openControl(options: ConversationControlOptions): Promise<ConversationWorkspaceHandle>
}

/** 项目会话按需发现与调用代码能力；标准 Node 进程和后台任务由应用宿主持有。 */
export class WorkbenchConversationSession implements WorkbenchConversationSessionApi {
  public constructor(
    private readonly shells: WorkbenchShellHostRegistryApi,
    private readonly nodeExecutable?: string,
    private readonly nodePackagesDirectory?: string
  ) {}

  public async open(options: ConversationWorkspaceOptions): Promise<ConversationWorkspaceHandle> {
    options.signal.throwIfAborted()
    const root = options.workspace
    const sandbox = options.sandbox ?? false
    let session: VelarosSession | undefined
    let runtime: VelarosRuntime | undefined
    const windows = new ProjectActivityWindows(root, options.activity, options.projectFilesEdited)
    const decide = async (
      message: string,
      signal: AbortSignal,
      detail?: ToolConfirmationDecisionOptions | typeof LoginConfirmation
    ): Promise<ApprovalDecision> => {
      if (options.confirmationMode === 'never-ask' && detail !== LoginConfirmation)
        return { approved: true, message: null }
      if (!session) throw new AppError('UNAVAILABLE', workbenchMainText('conversation.notReady'))
      const answer = await session.request('confirmation', message, signal, detail)
      const approved = isBoolean(answer) ? answer : isPlainObject(answer) && isTrue(answer.approved)
      const reason = isPlainObject(answer) && isNonBlankString(answer.reason) ? answer.reason : null
      return { approved, message: approved ? null : reason }
    }
    const confirm = async (message: string, signal: AbortSignal): Promise<void> => {
      const decision = await decide(message, signal)
      if (!decision.approved)
        throw new AppError(
          'PERMISSION',
          decision.message ? `用户拒绝了此操作：${decision.message}` : '用户拒绝了此操作。'
        )
    }
    try {
      const shell = this.shells.host(root, sandbox ? 'workspace-write' : 'danger-full-access')
      const node = createNodeExecutionEnvironment({
        cwd: root,
        directory: resolve(options.dataDir, 'node'),
        executable: this.nodeExecutable,
        packageDirectory: this.nodePackagesDirectory,
        runtime: resolveWorkbenchNodeEnvironment(this.nodePackagesDirectory),
        host: {
          ...shell,
          runCommand: async (...args) => {
            const finish = options.activity?.beginCommand()
            try {
              return await shell.runCommand(...args)
            } finally {
              finish?.()
            }
          },
        },
        authorize: async (request, signal) => {
          options.signal.throwIfAborted()
          if (options.confirmationMode === 'ask-every-time') await confirm(request.source, signal)
        },
        output: options.showCommandOutput,
      })
      const modules: Array<NonNullable<Parameters<typeof createRuntime>[0]['modules']>[number]> = [
        createWorkbenchConsoleModule(
          this.shells,
          options.sessionId,
          root,
          sandbox,
          async (command, signal) => {
            options.signal.throwIfAborted()
            if (options.confirmationMode === 'ask-every-time') await confirm(command, signal)
          }
        ),
      ]
      const { memory, web, browser, sessions } = options
      if (sessions)
        modules.push(
          createCapabilityModule({
            surface: VelarSessionsModule,
            implementation: sessionsOperations,
            instanceId: options.sessionId,
            context: (call) => ({ abortSignal: call.signal, sessions }),
          })
        )
      if (web)
        modules.push(
          createCapabilityModule({
            surface: VelarWebModule,
            implementation: webOperations,
            instanceId: 'web',
            context: (call) => ({ abortSignal: call.signal, web }),
          })
        )
      if (browser) {
        const gate = createBrowserLoginGate({
          requestLoginCompletion: ({ message }) =>
            decide(message, options.signal, LoginConfirmation),
        })
        const mount = (call: OperationContext): BrowserOperationContext => ({
          abortSignal: call.signal,
          browser: gate.wrap(browser.port(call.signal)),
          attachImage: (image) => call.attach({ type: 'image-data', ...image }),
        })
        modules.push(
          createCapabilityModule({
            surface: VelarBrowserModule,
            implementation: browserOperations,
            instanceId: options.sessionId,
            context: mount,
          }),
          createCapabilityModule({
            surface: VelarDevtoolsModule,
            implementation: devtoolsOperations,
            instanceId: options.sessionId,
            context: mount,
          }),
          createCapabilityModule({
            surface: VelarCdpModule,
            implementation: cdpOperations,
            instanceId: options.sessionId,
            context: mount,
          })
        )
      }
      runtime = await createRuntime({
        node,
        residentModules: [],
        workspace: root,
        project: { code: true, images: true },
        instructions: options.instructions,
        environment: () => ({
          ...options.environment?.(),
          ...browser?.environment(),
          cwd: root,
          workspace: `project; ${sandbox ? 'workspace-write sandbox' : 'full local access'}`,
          home: homedir(),
        }),
        dataDir: options.dataDir,
        model: options.model,
        // 上下文维护与模型驱动用同一输入预算；恢复时驱动上限仍会进一步约束请求。
        context: {
          policy: {
            windowTokens: 'limits' in options.model ? options.model.limits?.inputTokens : undefined,
          },
          limits: { ...ModelUsageBudget, modelTokensPerHour: Number.MAX_SAFE_INTEGER },
          maintenance: { profile: ModelUsageBudget },
        },
        modules,
        limits: { turns: Number.MAX_SAFE_INTEGER },
        modelTools: {
          maxChildren: Number.MAX_SAFE_INTEGER,
          maxSessions: Number.MAX_SAFE_INTEGER,
        },
        agents: {
          profiles: {
            worker: {
              description: `在当前项目内完成子任务；继承主任务的模型连接与推理设置。`,
              instructions: options.instructions,
              model: options.model,
              node: true,
              modules: [
                ...new Set([
                  ...modules.map((module) => module.binding.moduleId),
                  'velaros:project',
                  'velaros:code',
                  'velaros:images',
                ]),
              ],
              budget: ModelUsageBudget,
              limits: { turns: Number.MAX_SAFE_INTEGER, timeoutMs: WorkerRunTimeoutMs },
            },
          },
          concurrency: 4,
          maxChildren: Number.MAX_SAFE_INTEGER,
        },
        widgets: { show: options.showWidget },
        search: false,
        memory: memory ? () => memory : false,
        authorize: async (invocation, descriptor, signal) => {
          options.signal.throwIfAborted()
          if (descriptor.effects !== 'write') return
          if (
            options.confirmationMode === 'ask-every-time' &&
            ProjectWritingModules.includes(invocation.binding.moduleId)
          )
            await confirm(
              `${invocation.binding.moduleId}.${invocation.operation}\n${JSON.stringify(invocation.input)}`,
              signal
            )
          windows.authorized(invocation)
        },
        onMetric: (metric) => windows.record(metric),
      })
      options.signal.throwIfAborted()
      session = await runtime.openSession(options.sessionId)
      const owner = runtime
      return {
        session,
        trace: (input) => owner.trace(options.sessionId, input),
        close: async () => {
          try {
            await owner.close()
          } finally {
            windows.closeAll()
          }
        },
      }
    } catch (error) {
      try {
        await runtime?.close()
      } finally {
        windows.closeAll()
      }
      throw error
    }
  }

  public async openControl(
    options: ConversationControlOptions
  ): Promise<ConversationWorkspaceHandle> {
    const runtime = await createRuntime({
      ...options,
      project: false,
      agents: false,
      search: false,
      memory: false,
      context: { maintenance: false },
    })
    try {
      return { session: await runtime.openSession(options.sessionId), close: () => runtime.close() }
    } catch (error) {
      await runtime.close()
      throw error
    }
  }
}

/**
 * 效果闸计量 → 归属账本的时间窗。闸放行（`effect-wait` 且成功）开窗，同一次操作跑完（`effect-run`）关窗；
 * 一个运行时里的写互斥，同一个键下按先进先出配对。运行时关闭时还开着的窗一并关掉。
 *
 * 项目编辑另记它写到哪些文件：派发前放行时从入参读下来排队，过闸时随窗取走（没过闸的作废），成功跑完先交给
 * 语言服务再关窗——关窗会通知界面重读文件、重算诊断，语言服务得先拿到新内容。
 */
class ProjectActivityWindows {
  private readonly open = new Map<string, ActivityWindow[]>()
  private readonly edits = new Map<string, string[][]>()

  public constructor(
    private readonly root: string,
    private readonly activity?: WorkbenchAgentProjectActivityPort,
    private readonly edited?: (paths: readonly string[]) => void
  ) {}

  /** 这次调用过了宿主的权限检查、马上派发。 */
  public authorized(invocation: PreparedInvocation): void {
    const operation = `${invocation.binding.moduleId}.${invocation.operation}`
    if (!this.edited || operation !== ProjectCommitOperation) return
    enqueue(
      this.edits,
      windowKey(invocation.sessionId, invocation.executionId, operation),
      readCommitPaths(invocation.input, this.root)
    )
  }

  public record(metric: RuntimeMetric): void {
    if (metric.phase === 'storage') return
    if (!ProjectWritingModules.some((moduleId) => metric.operation.startsWith(`${moduleId}.`)))
      return
    const key = windowKey(metric.sessionId, metric.executionId ?? '', metric.operation)
    if (metric.phase === 'effect-wait') {
      const paths =
        metric.operation === ProjectCommitOperation ? dequeue(this.edits, key) : undefined
      if (!metric.succeeded) return
      enqueue(this.open, key, { finish: this.activity?.beginCommand(), paths })
      return
    }
    const window = dequeue(this.open, key)
    if (!window) return
    if (metric.succeeded && window.paths?.length) this.edited?.(window.paths)
    window.finish?.()
  }

  public closeAll(): void {
    const pending = [...this.open.values()].flat()
    this.open.clear()
    this.edits.clear()
    for (const window of pending) window.finish?.()
  }
}

/** 一段开着的改项目时间窗：关窗回调，以及项目编辑要写的路径。 */
interface ActivityWindow {
  readonly finish?: () => void
  readonly paths?: readonly string[]
}

function windowKey(sessionId: string, executionId: string, operation: string): string {
  return `${sessionId}\0${executionId}\0${operation}`
}

function enqueue<T>(queues: Map<string, T[]>, key: string, value: T): void {
  const queue = queues.get(key) ?? []
  queue.push(value)
  queues.set(key, queue)
}

function dequeue<T>(queues: Map<string, T[]>, key: string): T | undefined {
  const queue = queues.get(key)
  const value = queue?.shift()
  if (!queue?.length) queues.delete(key)
  return value
}

/**
 * `commit` 变更涉及的路径，换算成相对项目根：正文变更的 path，以及移动的 from/to。
 * 模型给的相对路径按项目根解析；落在项目外的不要（Platform 也不会写）。
 */
function readCommitPaths(input: unknown, root: string): string[] {
  if (!isPlainObject(input) || !isArray(input.changes)) return []
  const paths = input.changes.flatMap((change) =>
    isPlainObject(change) ? [change.path, change.from, change.to].filter(isNonBlankString) : []
  )
  return [
    ...new Set(
      paths
        .map((path) => relative(root, resolve(root, path)))
        .filter((path) => path !== '' && isRelativePathInsideRoot(path))
    ),
  ]
}
