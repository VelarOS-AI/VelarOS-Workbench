import { isAbsolute, relative, resolve } from 'node:path'

import { isArray, isBoolean, isNonBlankString, isPlainObject, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  ApprovalDecision,
  PreparedInvocation,
  ToolConfirmationDecisionOptions,
} from '@velaros-ai/kernel'
import type { CodeRunnerApi } from '@velaros-ai/script'
import type { RuntimeMetric, VelarosRuntime, VelarosSession } from '@velaros-ai/velaros'
import { createRuntime, createShellCapabilityModule } from '@velaros-ai/velaros'
import { projectCapabilityPorts } from '@velaros-ai/velaros/project'
import type { ShellSpacePort } from '@velaros-ai/velaros/shell'
import { shellCommandApproval } from '@velaros-ai/velaros/shell'

import { resolveWorkspaceIntegrityConfirmation } from '../workspace/CommandExecutionPolicy'
import type { WorkbenchAgentProjectActivityPort } from '../workspace/git/WorkbenchChatRunAttribution'

import type {
  ConversationControlOptions,
  ConversationWorkspaceHandle,
  ConversationWorkspaceOptions,
} from './WorkbenchConversationTypes'
import type { WorkbenchShellHostRegistryApi } from './WorkbenchShellHostRegistry'

/**
 * 每轮都会用到的模块：合同直接附进运行说明，模型不必先 list / describe；没挂载的由 Platform 忽略。
 * 与 Desktop 的项目会话同一套，外加问代码（定义、引用、诊断）：IDE 里几乎每轮都要用它。
 */
const ResidentModules = [
  'velaros:project',
  'velaros:code',
  'velaros:shell',
  'velaros:interaction',
  'velaros:widget',
]

/** 会改项目文件的模块：它们的写操作时间窗报给「本轮改动」的归属账本。 */
const ProjectWritingModules: readonly string[] = ['velaros:project', 'velaros:shell']

/** 确认卡上的命令只摊开第一行的这么多字符（与平台的危险命令确认卡同一口径）。 */
const ConfirmationCommandChars = 120

/** 按路径写项目文件的操作：写到哪些文件从派发前的入参读（Platform 的计量不带路径）。 */
const ProjectEditOperation = 'velaros:project.edit'

/** 执行会话的装配：一轮一个 Platform 运行时，收尾即关。 */
export interface WorkbenchConversationSessionApi {
  /** 打开可执行模型与项目操作的主会话。 */
  open(options: ConversationWorkspaceOptions): Promise<ConversationWorkspaceHandle>
  /** 打开无模型的状态控制会话（空闲时读、改目标）。 */
  openControl(options: ConversationControlOptions): Promise<ConversationWorkspaceHandle>
}

/**
 * 把一轮运行接到 Platform：项目模块、问代码与看图由 Platform 在同一个项目内核上挂；命令借用应用共用的
 * shell 宿主（这一轮起的后台任务在运行结束后接着跑，关闭时不释放宿主）。
 *
 * 「本轮改动」要知道 Agent 什么时候在改项目：Platform 的写操作都要过同一道效果闸（一个运行时里的写互斥），
 * 闸放行与这次操作跑完各报一次计量；项目与 shell 模块的这两点之间就是一段 Agent 动手的时间窗，交给归属账本。
 */
export class WorkbenchConversationSession implements WorkbenchConversationSessionApi {
  public constructor(
    private readonly runner: CodeRunnerApi,
    private readonly shells: WorkbenchShellHostRegistryApi
  ) {}

  public async open(options: ConversationWorkspaceOptions): Promise<ConversationWorkspaceHandle> {
    options.signal.throwIfAborted()
    const root = options.workspace
    let session: VelarosSession | undefined
    let runtime: VelarosRuntime | undefined
    const windows = new ProjectActivityWindows(root, options.activity, options.projectFilesEdited)
    // 审批选项（危险命令的操作身份与风险）随请求交给交互卡；回答是卡上给的 { approved, reason }
    const decide = async (
      message: string,
      signal: AbortSignal,
      detail?: ToolConfirmationDecisionOptions
    ): Promise<ApprovalDecision> => {
      // 「从不询问」档连危险命令也直接放行
      if (options.confirmationMode === 'never-ask') return { approved: true, message: null }
      if (!session) throw new AppError('UNAVAILABLE', '会话尚未就绪。')
      const answer = await session.request('confirmation', message, signal, detail)
      const approved = isBoolean(answer) ? answer : isPlainObject(answer) && isTrue(answer.approved)
      const reason = isPlainObject(answer) && isNonBlankString(answer.reason) ? answer.reason : null
      return { approved, message: approved ? null : reason }
    }
    const confirm = async (
      message: string,
      signal: AbortSignal,
      detail?: ToolConfirmationDecisionOptions
    ): Promise<void> => {
      const decision = await decide(message, signal, detail)
      if (!decision.approved)
        throw new AppError(
          'PERMISSION',
          decision.message ? `用户拒绝了此操作：${decision.message}` : '用户拒绝了此操作。'
        )
    }
    try {
      const shell = this.shells.host(root, 'danger-full-access')
      const port = projectCapabilityPorts.shell(
        { ...shell, getRootPath: () => root },
        options.signal
      )
      runtime = await createRuntime({
        runner: this.runner,
        workspace: root,
        // 同一个项目内核上另挂问代码（定义、引用、诊断）与看项目里的图。
        project: { code: true, images: true },
        instructions: options.instructions,
        residentModules: ResidentModules,
        environment: options.environment,
        dataDir: options.dataDir,
        model: options.model,
        modules: [
          createShellCapabilityModule({
            instanceId: root,
            shell: port,
            // 前台命令跑着时的输出画到脚本卡上，跑完换成结果。
            output: (output) => options.showCommandOutput(output),
            approval: {
              awaitConfirmation: (message, signal = options.signal, detail) =>
                confirm(message, signal, detail),
              awaitConfirmationDecision: (message, signal = options.signal, detail) =>
                decide(message, signal, detail),
            },
          }),
        ],
        // 子任务用 Platform 的默认配置 worker：与主会话同一个模型、同一套模块。
        agents: true,
        widgets: { show: (widget) => options.showWidget(widget) },
        search: false,
        // IDE 不接长期记忆：项目自己的说明与代码就是上下文。
        memory: false,
        authorize: async (invocation, descriptor, signal) => {
          options.signal.throwIfAborted()
          if (
            descriptor.effects !== 'write' ||
            !ProjectWritingModules.includes(invocation.binding.moduleId)
          )
            return
          if (options.confirmationMode === 'ask-every-time') {
            await confirm(
              `${invocation.binding.moduleId}.${invocation.operation}\n${JSON.stringify(invocation.input)}`,
              signal
            )
          } else if (options.confirmationMode === 'standard-open') {
            const request = await workspaceIntegrityConfirmation(invocation, port, root)
            if (request) await confirm(request.message, signal, request.options)
          }
          windows.authorized(invocation)
        },
        onMetric: (metric) => windows.record(metric),
      })
      options.signal.throwIfAborted()
      session = await runtime.openSession(options.sessionId)
      const owner = runtime
      return {
        session,
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

  /** 空闲时的目标控制只打开绑定工作区的存储；不配置模型或业务操作。 */
  public async openControl(options: ConversationControlOptions): Promise<ConversationWorkspaceHandle> {
    const runtime = await createRuntime({
      runner: this.runner,
      ...options,
      project: false,
      agents: false,
      search: false,
      memory: false,
      context: { maintenance: false },
    })
    try {
      return {
        session: await runtime.openSession(options.sessionId),
        close: () => runtime.close(),
      }
    } catch (error) {
      await runtime.close()
      throw error
    }
  }
}

/**
 * 标准档下 Agent 命令的补问：会丢工作区里没提交的改动、切走分支或写到项目外的命令（`git reset --hard`、
 * `git checkout`、`git pull` 这类，判据见 `CommandExecutionPolicy`）平台照常直接跑，IDE 里先问用户一句，
 * 与迁到 Platform 之前的 Workbench 一致；平台自己判危险的由 `velaros:shell` 问，这里不重复。
 * 确认卡与平台的危险命令同一套选项：手动确认、不按类记忆，操作身份与平台跨入口一致。
 * 观察调用会自动重跑，这类命令与平台的危险命令一样直接拒绝，要走一次性执行。
 */
async function workspaceIntegrityConfirmation(
  invocation: PreparedInvocation,
  shell: ShellSpacePort,
  projectRoot: string
): Promise<Nullable<{ message: string; options: ToolConfirmationDecisionOptions }>> {
  if (invocation.binding.moduleId !== 'velaros:shell' || invocation.operation !== 'run') return null
  const input = invocation.input
  if (!isPlainObject(input) || !isNonBlankString(input.command)) return null
  const integrity = resolveWorkspaceIntegrityConfirmation(input.command, projectRoot)
  if (!integrity) return null
  if (invocation.mode === 'observe')
    throw new AppError(
      'OBSERVATION_EFFECT_DENIED',
      `观察会自动重跑，这条命令请通过一次性执行入口运行：${integrity.reason}`
    )
  const requestedCwd = isNonBlankString(input.cwd) ? input.cwd : undefined
  // 与平台同一顺序：工作目录先由空间解析，越出项目的在问用户之前就拒绝。
  const cwd = await shell.resolveCwd(requestedCwd)
  const { scopeLabel, riskScope } = shell.commandPolicy(requestedCwd)
  const background =
    input.interactive === true ||
    (isBoolean(input.background) ? input.background : integrity.plan.shouldStartInBackground)
  const { options } = shellCommandApproval.dangerous({
    command: input.command,
    plan: { ...integrity.plan, isDangerous: true, dangerousReason: integrity.reason },
    cwd,
    background,
    scopeLabel,
    riskScope,
  })
  // 确认卡只摊开第一行：「在当前项目重置 Git 工作区：git reset --hard」；完整理由在第二行，回答之后点开回看。
  const head = input.command.trim().split('\n')[0]?.trim() ?? ''
  const shown = head.length > ConfirmationCommandChars ? `${head.slice(0, ConfirmationCommandChars)}…` : head
  return { message: `在${scopeLabel}${integrity.title}：${shown}\n${integrity.reason}`, options }
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
    if (!this.edited || operation !== ProjectEditOperation) return
    enqueue(
      this.edits,
      windowKey(invocation.sessionId, invocation.executionId, operation),
      readEditPaths(invocation.input, this.root)
    )
  }

  public record(metric: RuntimeMetric): void {
    if (metric.phase === 'storage') return
    if (!ProjectWritingModules.some((moduleId) => metric.operation.startsWith(`${moduleId}.`)))
      return
    const key = windowKey(metric.sessionId, metric.executionId ?? '', metric.operation)
    if (metric.phase === 'effect-wait') {
      const paths = metric.operation === ProjectEditOperation ? dequeue(this.edits, key) : undefined
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
 * `edit` 各步写到的路径，换算成相对项目根：写整份、换原文、删除的 path，移动的两头，转码的 paths。
 * 模型给的相对路径按项目根解析；落在项目外的不要（Platform 也不会写）。
 */
function readEditPaths(input: unknown, root: string): string[] {
  if (!isPlainObject(input) || !isArray(input.steps)) return []
  const paths = input.steps.flatMap((step) =>
    isPlainObject(step)
      ? [step.path, step.to, ...(isArray(step.paths) ? step.paths : [])].filter(isNonBlankString)
      : []
  )
  return [
    ...new Set(
      paths
        .map((path) => relative(root, resolve(root, path)))
        .filter((path) => path !== '' && !path.startsWith('..') && !isAbsolute(path))
    ),
  ]
}
