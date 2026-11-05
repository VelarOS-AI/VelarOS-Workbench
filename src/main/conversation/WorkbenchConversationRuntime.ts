import { resolve } from 'node:path'

import type { InteractionAnswer } from '@velaros-ai/ui/conversation/contracts'
import type { RuntimeNoteRead, VelarosSession } from '@velaros-ai/velaros'
import type { GoalControl, GoalState } from '@velaros-ai/velaros/contracts'
import { isNotUndefined, Log, toNullable } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import type { ActPresentation } from '@velaros-ai/velaros/renderer'
import { createActEventProjector } from '@velaros-ai/velaros/renderer'
import type { CodeRunnerApi } from '@velaros-ai/velaros/script'
import type { SessionsSpacePort } from '@velaros-ai/velaros/sessions'
import type { SessionAnswer } from '@velaros-ai/velaros/sessions/contracts'
import type { WebSpacePort } from '@velaros-ai/velaros/web'

import {
  ConversationAgentNotice,
  ConversationCommandOutputNotice,
  ConversationInteractionNotice,
  ConversationProjectActivityNotice,
  ConversationScriptNotice,
  ConversationTextNotice,
  ConversationThinkingNotice,
  ConversationWidgetNotice,
  type WorkbenchConversationCancelResult,
  type WorkbenchConversationSendRequest,
  type WorkbenchConversationState,
} from '../../shared/workbenchConversation'
import type { ConversationBrowser } from '../browser/WorkbenchBrowserService'
import { workbenchMainText } from '../i18n/workbenchMainMessages'
import type { WorkbenchAgentProjectActivityPort } from '../workspace/git/WorkbenchChatRunAttribution'

import { ConversationAgentBoard } from './ConversationAgents'
import { ConversationCommandOutputBoard } from './ConversationCommandOutput'
import {
  awaitingState,
  ConversationInteractionBoard,
  interactionKind,
  platformAnswer,
} from './ConversationInteractions'
import { ConversationScriptBoard } from './ConversationScripts'
import { ConversationTextBoard } from './ConversationText'
import { ConversationThinkingBoard } from './ConversationThinking'
import { ConversationTraceQueue } from './ConversationTraceQueue'
import {
  buildHostInstructions,
  contextUsageFromProvider,
  conversationDone,
  stalledMessage,
  terminalStatusMessage,
  throttledMessage,
  toConversationInput,
} from './WorkbenchConversationRules'
import { WorkbenchConversationSession } from './WorkbenchConversationSession'
import { WorkbenchConversationStore } from './WorkbenchConversationStore'
import type {
  ActiveConversationRun,
  ConversationControlOptions,
  ConversationInput,
  ConversationProjectRule,
  ConversationRunConfiguration,
  ConversationSessionEvent,
  ConversationWorkspaceHandle,
  ConversationWorkspaceOptions,
} from './WorkbenchConversationTypes'
import type { ConversationMemory } from './WorkbenchMemoryService'
import type { WorkbenchShellHostRegistryApi } from './WorkbenchShellHostRegistry'

const log = Log.tag('WorkbenchConversationRuntime')

/** 一轮运行的展示流：通知（脚本卡、正文、交互卡……）与运行状态逐条推给发起它的窗口。 */
export interface WorkbenchConversationSink {
  notice(kind: string, payload: unknown): void
  state(payload: WorkbenchConversationState): void
}

/** 会话身份：Workbench 的会话属于某个项目。 */
export interface WorkbenchConversationRef {
  projectRoot: string
  sessionId: string
}

/** 回合追踪投到的几块账：正文（缺证据的提示）、脚本卡、子 Agent 线程与脚本卡上的运行中输出。 */
interface ConversationTraceBoards {
  readonly text: ConversationTextBoard
  readonly scripts: ConversationScriptBoard
  readonly agents: ConversationAgentBoard
  readonly commandOutput: ConversationCommandOutputBoard
}

interface WorkbenchConversationRuntimeOptions {
  sessions?(request: WorkbenchConversationSendRequest): SessionsSpacePort | undefined
  /** 宿主明确提供执行进程，主聊天不自行选择进程实现。 */
  runner?: CodeRunnerApi
  nodeExecutable?: string
  nodePackagesDirectory?: string
  /** 应用共用的本机 shell 宿主：每轮借用，会话删除时停掉它的后台任务。 */
  shells: WorkbenchShellHostRegistryApi
  /** Platform 会话数据根目录（在任何项目之外）。 */
  dataDir: string
  /** 按当前请求解析模型驱动与服务商。 */
  configure(
    request: WorkbenchConversationSendRequest,
    signal: AbortSignal
  ): Promise<ConversationRunConfiguration>
  /** 宿主环境条目（如操作系统）；Platform 每帧把它和当地时间一起交给模型。 */
  environment?(): Readonly<Record<string, string>>
  /** 这一轮 Agent 改项目的时间窗报到哪里（「本轮改动」的归属账本）。 */
  activity?(ref: WorkbenchConversationRef): WorkbenchAgentProjectActivityPort
  /** Agent 的一次项目编辑写完了这些文件（相对项目根）：告诉语言服务，不等文件监听。 */
  projectFilesEdited?(ref: WorkbenchConversationRef, paths: readonly string[]): void
  /** 这一轮接的长期记忆（`workspace` 是项目根的真实路径）；请求里关了记忆时不问。 */
  memory?(workspace: string): Promise<ConversationMemory>
  /** 网上查资料（`velaros:web`）的无头页面；搜索引擎按这一轮请求里的设置。不给就不挂这个模块。 */
  webPages?: Pick<WebSpacePort, 'openPage' | 'resolveRedirect'>
  /**
   * Agent 浏览器：每一轮交给模型这个会话的受控页面，一轮结束（不论成败）不再给它开后台页面，会话删了就离站。
   * 不给就不挂浏览器模块。
   */
  browser?: {
    conversation(ref: WorkbenchConversationRef): ConversationBrowser
    settleRun(ref: WorkbenchConversationRef): void
    leaveSite(ref: WorkbenchConversationRef): Promise<void>
  }
  /** 项目里的 AI 规则文件（AGENTS.md 等），每轮附进宿主说明；读不到就不附。 */
  projectRules?(projectRoot: string): Promise<readonly ConversationProjectRule[]>
  /** 注入执行会话的资源所有者（测试用）。 */
  open?(options: ConversationWorkspaceOptions): Promise<ConversationWorkspaceHandle>
  /** 注入空闲状态控制会话的资源所有者（测试用）。 */
  control?(options: ConversationControlOptions): Promise<ConversationWorkspaceHandle>
}

/** 主聊天的 Platform 控制面（与 Desktop 的会话运行时同一套流程）。 */
export interface WorkbenchConversationRuntimeApi {
  isRunning(ref: WorkbenchConversationRef): boolean
  subscribeRunSettled(listener: (ref: WorkbenchConversationRef) => void): () => void
  subscribeRunOutcome(listener: (outcome: WorkbenchConversationRunOutcome) => void): () => void
  /** 提交这一条用户输入：被运行时接纳时 accepted 完成，整轮收尾时 completed 完成。 */
  submit(
    sink: WorkbenchConversationSink,
    request: WorkbenchConversationSendRequest
  ): { accepted: Promise<void>; completed: Promise<void> }
  /** 停下这个会话的运行并等资源释放；返回还没被读走的引导。 */
  cancel(ref: WorkbenchConversationRef): Promise<WorkbenchConversationCancelResult>
  /** 运行中追加一条引导。 */
  guidance(ref: WorkbenchConversationRef, input: { inputId: string; text: string }): Promise<void>
  /** 输入框里回答一句话的提问。 */
  input(ref: WorkbenchConversationRef, answer: string): Promise<void>
  /** 交互卡上的回答。 */
  answer(ref: WorkbenchConversationRef, requestId: string, answer: InteractionAnswer): Promise<void>
  listNotes(
    ref: WorkbenchConversationRef,
    input?: { after?: string; limit?: number }
  ): ReturnType<VelarosSession['listNotes']>
  readNote(
    ref: WorkbenchConversationRef,
    input: RuntimeNoteRead
  ): ReturnType<VelarosSession['readNote']>
  subscribeNotesChanged(listener: (ref: WorkbenchConversationRef) => void): () => void
  /** 读取当前目标。 */
  getGoal(ref: WorkbenchConversationRef): Promise<Nullable<GoalState>>
  /** 以当前版本执行用户的目标操作；除了继续，其余操作会停下正在跑的这一轮。 */
  controlGoal(ref: WorkbenchConversationRef, input: GoalControl): Promise<GoalState>
  /** 停下这个会话的一切并删除它的 Platform 数据。 */
  deleteSession(ref: WorkbenchConversationRef): Promise<void>
  /** 停下某个项目里的全部运行（窗口关掉或切走项目时）。 */
  cancelProject(projectRoot: string): Promise<void>
  /** 停止全部运行并等待资源释放。 */
  close(): Promise<void>
}

export interface WorkbenchConversationRunOutcome extends WorkbenchConversationRef {
  inputId: string
  result: SessionAnswer
}

/**
 * 把 Workbench 的主聊天接到 Platform：持久上下文和实际执行全部归 Platform 运行时，这里只做一轮运行的
 * 装配、事件到界面通知的投影，以及回答、引导、取消与目标控制的转交。一轮一个运行时，收尾即关。
 */
export class WorkbenchConversationRuntime implements WorkbenchConversationRuntimeApi {
  private readonly session: WorkbenchConversationSession
  private readonly storage: WorkbenchConversationStore
  private readonly active = new Map<string, ActiveConversationRun>()
  /** 每次运行的交互卡账；回答从 IPC 进来时按会话找到当前运行的这一本。 */
  private readonly interactions = new WeakMap<ActiveConversationRun, ConversationInteractionBoard>()
  private readonly controlOperations = new Map<string, Promise<unknown>>()
  private readonly deleting = new Set<string>()
  private readonly notebookListeners = new Set<(ref: WorkbenchConversationRef) => void>()
  private readonly settledListeners = new Set<(ref: WorkbenchConversationRef) => void>()
  private readonly outcomeListeners = new Set<(outcome: WorkbenchConversationRunOutcome) => void>()
  private closing?: Promise<void>

  public constructor(private readonly options: WorkbenchConversationRuntimeOptions) {
    this.session = new WorkbenchConversationSession(
      options.runner,
      options.shells,
      options.nodeExecutable,
      options.nodePackagesDirectory
    )
    this.storage = new WorkbenchConversationStore(options.dataDir)
  }

  public submit(
    sink: WorkbenchConversationSink,
    request: WorkbenchConversationSendRequest
  ): { accepted: Promise<void>; completed: Promise<void> } {
    const key = runKey(request)
    if (this.closing || this.deleting.has(key))
      throw new AppError('VALIDATION', workbenchMainText('conversation.closing'))
    if (this.active.has(key))
      throw new AppError('VALIDATION', workbenchMainText('conversation.busy'))
    const input = toConversationInput(request)
    let accept!: () => void
    let reject!: (error: unknown) => void
    const accepted = new Promise<void>((yes, no) => {
      accept = yes
      reject = no
    })
    const run: ActiveConversationRun = {
      controller: new AbortController(),
      completed: Promise.resolve(),
    }
    this.active.set(key, run)
    run.completed = Promise.resolve()
      .then(() => this.consume(sink, request, input, run, accept))
      .catch((error) => {
        reject(error)
        throw error
      })
      .finally(() => {
        this.active.delete(key)
        this.notifyNotesChanged(request)
        if (run.outcome)
          for (const listener of this.outcomeListeners) {
            try {
              listener({
                projectRoot: request.projectRoot,
                sessionId: request.sessionId,
                inputId: request.inputId,
                result: run.outcome,
              })
            } catch (error) {
              log.warn('会话结果通知失败', { error })
            }
          }
        for (const listener of this.settledListeners) {
          try {
            listener({ projectRoot: request.projectRoot, sessionId: request.sessionId })
          } catch (error) {
            log.warn('会话结束通知失败', { error })
          }
        }
      })
    // 同时观察两张回执，避免 IPC 尚在等待 accepted 时 completed 的拒绝无人接收。
    void Promise.allSettled([accepted, run.completed])
    return { accepted, completed: run.completed }
  }

  public isRunning(ref: WorkbenchConversationRef): boolean {
    return this.active.has(runKey(ref))
  }

  public subscribeRunSettled(listener: (ref: WorkbenchConversationRef) => void): () => void {
    this.settledListeners.add(listener)
    return () => this.settledListeners.delete(listener)
  }

  public subscribeRunOutcome(
    listener: (outcome: WorkbenchConversationRunOutcome) => void
  ): () => void {
    this.outcomeListeners.add(listener)
    return () => this.outcomeListeners.delete(listener)
  }

  public async cancel(ref: WorkbenchConversationRef): Promise<WorkbenchConversationCancelResult> {
    const run = this.active.get(runKey(ref))
    if (!run) return { aborted: false }
    run.controller.abort()
    run.handle?.session.cancel()
    // 取消等待资源结算；执行失败由聊天终态及原 completed 回执交付。
    await Promise.allSettled([run.completed])
    return { aborted: true, retainedInputIds: [...(run.presentation?.retainedInputIds ?? [])] }
  }

  public async guidance(
    ref: WorkbenchConversationRef,
    input: { inputId: string; text: string }
  ): Promise<void> {
    await this.requireSession(ref).steer(toConversationInput(input))
  }

  public async input(ref: WorkbenchConversationRef, answer: string): Promise<void> {
    const session = this.requireSession(ref)
    const request = (await session.inspect()).pending.find(
      (item) => interactionKind(item) === 'input'
    )
    if (!request)
      throw new AppError('VALIDATION', workbenchMainText('conversation.noPendingQuestion'))
    await session.answer({ id: request.id, runId: request.runId, value: answer })
    // 卡片上照样写上这句回答
    this.interactionBoard(ref)?.answer(request.id, { text: answer })
  }

  public async answer(
    ref: WorkbenchConversationRef,
    requestId: string,
    answer: InteractionAnswer
  ): Promise<void> {
    const session = this.requireSession(ref)
    const request = (await session.inspect()).pending.find((item) => item.id === requestId)
    if (!request) throw new AppError('VALIDATION', workbenchMainText('conversation.requestExpired'))
    await session.answer({
      id: request.id,
      runId: request.runId,
      value: platformAnswer(request, answer),
    })
    this.interactionBoard(ref)?.answer(request.id, answer)
  }

  public listNotes(ref: WorkbenchConversationRef, input: { after?: string; limit?: number } = {}) {
    return this.withSessionControl(
      ref,
      (session) => session.listNotes(input),
      { items: [], nextAfter: null },
      { readActive: true }
    )
  }

  public readNote(ref: WorkbenchConversationRef, input: RuntimeNoteRead) {
    return this.withSessionControl(ref, (session) => session.readNote(input), undefined, {
      readActive: true,
    })
  }

  public subscribeNotesChanged(listener: (ref: WorkbenchConversationRef) => void): () => void {
    this.notebookListeners.add(listener)
    return () => this.notebookListeners.delete(listener)
  }

  private notifyNotesChanged(ref: WorkbenchConversationRef): void {
    for (const listener of this.notebookListeners) {
      try {
        listener({ sessionId: ref.sessionId, projectRoot: ref.projectRoot })
      } catch (error) {
        log.warn('工作笔记刷新通知失败', { error })
      }
    }
  }

  public getGoal(ref: WorkbenchConversationRef): Promise<Nullable<GoalState>> {
    return this.withSessionControl(ref, (session) => session.getGoal(), null, { readActive: true })
  }

  public controlGoal(ref: WorkbenchConversationRef, input: GoalControl): Promise<GoalState> {
    return this.withSessionControl(
      ref,
      async (session) => {
        const goal = await session.getGoal()
        if (!goal) throw new AppError('NOT_FOUND', workbenchMainText('conversation.noGoal'))
        if (input.baseRevision !== goal.revision)
          throw new AppError('VALIDATION', workbenchMainText('conversation.goalChanged'))
        return session.controlGoal({ ...input, baseRevision: goal.revision })
      },
      undefined,
      { controlActive: true, stopAfter: input.action !== 'resume' }
    )
  }

  public async deleteSession(ref: WorkbenchConversationRef): Promise<void> {
    const key = runKey(ref)
    this.deleting.add(key)
    try {
      await this.cancel(ref)
      // 会话删掉后，它起的后台进程就没人看得到、停得了：一并强杀；没停下的记日志，不拦删除。
      await this.options.shells.terminateSessionBackgroundTasks(
        ref.sessionId,
        await this.storage.workspace(ref.projectRoot)
      )
      // 它的浏览器页面也没人看了：离站，关掉页面。
      await this.options.browser
        ?.leaveSite(ref)
        .catch((error: unknown) =>
          log.warn('删除会话时浏览器没能离站', { error: AppError.getMessage(error) })
        )
      await Promise.allSettled([this.controlOperations.get(key)])
      await this.storage.delete(ref.projectRoot, ref.sessionId)
    } finally {
      this.deleting.delete(key)
    }
  }

  public async cancelProject(projectRoot: string): Promise<void> {
    const prefix = `${resolve(projectRoot)}\0`
    const runs = [...this.active.entries()].filter(([key]) => key.startsWith(prefix))
    for (const [, run] of runs) {
      run.controller.abort()
      run.handle?.session.cancel()
    }
    await Promise.allSettled(runs.map(([, run]) => run.completed))
  }

  public close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const runs = [...this.active.values()]
      for (const run of runs) {
        run.controller.abort()
        run.handle?.session.cancel()
      }
      await Promise.allSettled([
        ...runs.map((run) => run.completed),
        ...this.controlOperations.values(),
      ])
      this.notebookListeners.clear()
    })
    return this.closing
  }

  /** 这个会话当前运行的交互卡账；没有运行时没有。 */
  private interactionBoard(
    ref: WorkbenchConversationRef
  ): ConversationInteractionBoard | undefined {
    const run = this.active.get(runKey(ref))
    return run && this.interactions.get(run)
  }

  private requireSession(ref: WorkbenchConversationRef): ConversationWorkspaceHandle['session'] {
    const session = this.active.get(runKey(ref))?.handle?.session
    if (!session) throw new AppError('VALIDATION', workbenchMainText('conversation.noActiveRun'))
    return session
  }

  private async withSessionControl<T>(
    ref: WorkbenchConversationRef,
    operation: (session: ConversationWorkspaceHandle['session']) => Promise<T>,
    missing?: T,
    options: { readActive?: boolean; controlActive?: boolean; stopAfter?: boolean } = {}
  ): Promise<T> {
    const key = runKey(ref)
    if (!ref.sessionId.trim() || this.closing || this.deleting.has(key))
      throw new AppError('UNAVAILABLE', workbenchMainText('conversation.closingOrInvalid'))
    const previous = this.controlOperations.get(key)
    // 队列等待前一操作结算；各操作的成功或失败仍由各自调用者接收。
    const pending = Promise.allSettled(previous ? [previous] : []).then(async () => {
      if (this.closing || this.deleting.has(key))
        throw new AppError('UNAVAILABLE', workbenchMainText('conversation.closing'))
      const active = this.active.get(key)
      if (options.controlActive && active) {
        if (!active.handle)
          throw new AppError('UNAVAILABLE', workbenchMainText('conversation.preparing'))
        const result = await operation(active.handle.session)
        if (options.stopAfter) await this.cancel(ref)
        return result
      }
      if (options.readActive && active) {
        if (active.handle) return operation(active.handle.session)
        if (isNotUndefined(missing)) return missing
        throw new AppError('UNAVAILABLE', workbenchMainText('conversation.preparing'))
      }
      if (!(await this.storage.exists(ref.projectRoot, ref.sessionId))) {
        if (isNotUndefined(missing)) return missing
        throw new AppError('NOT_FOUND', workbenchMainText('conversation.neverRan'))
      }
      const handle = await (
        this.options.control ?? ((control) => this.session.openControl(control))
      )({
        sessionId: ref.sessionId,
        dataDir: this.storage.path(ref.projectRoot, ref.sessionId),
        workspace: await this.storage.workspace(ref.projectRoot),
      })
      try {
        return await operation(handle.session)
      } finally {
        await handle.close()
      }
    })
    this.controlOperations.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.controlOperations.get(key) === pending) this.controlOperations.delete(key)
    }
  }

  private async consume(
    sink: WorkbenchConversationSink,
    request: WorkbenchConversationSendRequest,
    input: ConversationInput,
    run: ActiveConversationRun,
    accept: () => void
  ): Promise<void> {
    const signal = run.controller.signal
    const startedAt = Date.now()
    // 回合 → 所属运行；回合边界与收尾按它读追踪。
    const turns = new Map<string, string>()
    const scripts = new ConversationScriptBoard((payload) =>
      sink.notice(ConversationScriptNotice, payload)
    )
    const agents = new ConversationAgentBoard(
      (payload) => sink.notice(ConversationAgentNotice, payload),
      () => run.modelId,
      (usage) => sink.state(usage),
      () => run.provider
    )
    const interactions = new ConversationInteractionBoard((payload) =>
      sink.notice(ConversationInteractionNotice, payload)
    )
    this.interactions.set(run, interactions)
    const thinking = new ConversationThinkingBoard((payload) =>
      sink.notice(ConversationThinkingNotice, payload)
    )
    const text = new ConversationTextBoard((payload) =>
      sink.notice(ConversationTextNotice, payload)
    )
    const commandOutput = new ConversationCommandOutputBoard(
      (payload) => sink.notice(ConversationCommandOutputNotice, payload),
      (executionId) => scripts.cardOf(executionId)
    )
    let lastTurn: string | undefined
    // 这一回合的响应派发了执行、还没进下一回合：执行开始到下一回合思考之间，等执行收尾的 waiting 也算
    let executing = false
    const traces = new ConversationTraceQueue((turnId, final) =>
      this.projectTrace(
        { text, scripts, agents, commandOutput },
        run,
        turns.get(turnId)!,
        turnId,
        final
      )
    )
    let admitted = false
    let failure: unknown
    let goal: Nullable<GoalState> = null
    try {
      // 读目标会临时打开同一份会话（界面选中会话就会读目标）：等它们收尾再起跑，发送不因此被拒。
      // 运行已登记为活动，之后进来的控制操作不会再打开会话。
      await Promise.allSettled([this.controlOperations.get(runKey(request))])
      signal.throwIfAborted()
      run.projector = createActEventProjector()
      run.locale = request.locale
      const { provider, model, imageInput } = await this.options.configure(request, signal)
      const submittedInput = imageInput ? input : withoutImages(input, request.locale)
      run.provider = provider
      run.modelId = model.id
      run.modelLimits = model.limits
      signal.throwIfAborted()
      const workspace = await this.storage.workspace(request.projectRoot)
      const activity = this.options.activity?.(request)
      const projectRules = await this.readProjectRules(request.projectRoot)
      const memory = request.memory ? await this.options.memory?.(workspace) : undefined
      signal.throwIfAborted()
      const webPages = this.options.webPages
      run.handle = await (this.options.open ?? ((options) => this.session.open(options)))({
        sessionId: request.sessionId,
        dataDir: this.storage.path(request.projectRoot, request.sessionId),
        workspace,
        sandbox: request.sandbox,
        environment: this.options.environment,
        // 小部件在脚本执行时交来：先把欠着的正文发掉，再按所在运行放进运行消息
        showWidget: (widget) => {
          const runId = lastTurn && turns.get(lastTurn)
          if (!runId) {
            log.warn('还没有模型回合，小部件没处放', { id: widget.id })
            return
          }
          text.flush()
          sink.notice(ConversationWidgetNotice, { ...widget, runId })
        },
        showCommandOutput: (output) => commandOutput.write(output),
        // 一段改项目的时间窗结束就告诉界面：「本轮改动」与 Git 状态据此刷新。
        activity: activity && {
          beginFileWrite: () => activity.beginFileWrite(),
          beginCommand: () => {
            const finish = activity.beginCommand()
            return () => {
              finish()
              const runId = lastTurn ? (turns.get(lastTurn) ?? null) : null
              sink.notice(ConversationProjectActivityNotice, { runId })
            }
          },
        },
        projectFilesEdited: (paths) => this.options.projectFilesEdited?.(request, paths),
        memory: memory?.scope,
        browser: this.options.browser?.conversation(request),
        sessions: this.options.sessions?.(request),
        web: webPages && {
          openPage: (pageSignal) => webPages.openPage(pageSignal),
          resolveRedirect: webPages.resolveRedirect
            ? (url, redirectSignal) => webPages.resolveRedirect!(url, redirectSignal)
            : undefined,
          searchEngine: () => request.webSearchEngine,
        },
        instructions: buildHostInstructions({
          locale: request.locale,
          executionModes: request.executionModes,
          projectRules,
        }),
        model,
        confirmationMode: request.permissionMode,
        signal,
      })
      signal.throwIfAborted()
      const session = run.handle.session
      // 运行期间定时重读：执行中的当前回合（父脚本等子任务时也看得到子任务在跑），以及还有子任务在跑的回合
      traces.watch(() => [
        ...new Set([
          ...(executing && lastTurn ? [lastTurn] : []),
          ...scripts.pendingTurns(),
          ...agents.pendingTurns(),
        ]),
      ])
      // 目标模式把这条消息交给 Platform 作目标：首帧读取目标之前写入，已有进行中的目标时保持原样。
      const submitOptions: { goal?: string } = {}
      if (request.executionModes.includes('goal') && input.text) submitOptions.goal = input.text
      for await (const event of session.submit(submittedInput, signal, submitOptions)) {
        // 思考和 program 一样不带回合身份，总属于最近开始的那个回合；它只作展示，节流后成段发出。
        if (event.type === 'reasoning') {
          if (lastTurn) thinking.append(lastTurn, event.runId, event.text)
          continue
        }
        thinking.flush()
        // 正文预览节流发出；别的事件发出前先把欠的发掉，保持同一回合里正文在脚本卡前面。
        if (event.type !== 'text') text.flush()
        if (!admitted && event.type === 'input' && event.source === 'submit') {
          signal.throwIfAborted()
          accept()
          admitted = true
        }
        if (event.type === 'turn' && !turns.has(event.turnId)) {
          if (lastTurn) await traces.read(lastTurn, false)
          turns.set(event.turnId, event.runId)
          lastTurn = event.turnId
          this.notifyNotesChanged(request)
          await traces.read(event.turnId, false)
        }
        if (event.type === 'state')
          executing = event.status === 'executing' || (executing && event.status === 'waiting')
        // program 事件不带回合身份：它总属于最近开始的那个回合。
        if (event.type === 'program' && lastTurn) scripts.program(lastTurn, event)
        if (event.type === 'accepted') scripts.accept(event.turnId)
        if (event.type === 'rejected') {
          scripts.reject(event.turnId)
          thinking.reject(event.turnId)
        }
        this.project(sink, text, run, event)
      }
      if (!admitted) {
        // Platform 给了具体原因就原样透出；没有时才用通用文案。
        const reason = run.presentation?.failure
        throw new AppError(
          'VALIDATION',
          reason ?? workbenchMainText('conversation.inputNotAccepted')
        )
      }
    } catch (error) {
      // 错误统一留到资源关闭后通过同一流发出终态。
      failure = AppError.from(error)
    } finally {
      thinking.flush()
      traces.stop()
      try {
        for (const turnId of turns.keys()) await traces.read(turnId, true)
        scripts.settle()
        agents.settle()
        interactions.settle()
        commandOutput.close()
        if (run.projector) {
          const previous = run.projector.snapshot()
          this.projectText(text, previous, run.projector.finish())
        }
        text.flush()
      } catch (error) {
        failure ??= AppError.from(error)
      }
      // 这次运行改过的目标，完成时带上它现在的状态；读不到不影响收尾
      try {
        goal = toNullable(await run.handle?.session.getGoal())
      } catch (error) {
        log.warn('收尾时读不到目标', { error, sessionId: request.sessionId })
      }
      try {
        await run.handle?.close()
      } catch (error) {
        failure ??= AppError.from(error)
      } finally {
        run.handle = undefined
        this.options.browser?.settleRun(request)
      }
    }
    const status = run.presentation?.status
    const outcome = (status: SessionAnswer['status'], reason: Nullable<string>): void => {
      run.outcome = {
        session: request.sessionId,
        status,
        answer: (
          run.presentation?.messages
            .map((message) => message.text)
            .filter((text) => text.trim())
            .join('\n\n') ?? ''
        ).slice(-8000),
        reason,
      }
    }
    if (
      failure ||
      run.presentation?.failure ||
      status === 'failed' ||
      status === 'context_blocked'
    ) {
      const reason = failure ?? run.presentation?.failure
      // 没有具体原因时不把状态名当文案给用户
      const message = reason
        ? AppError.getMessage(reason)
        : terminalStatusMessage(
            status as 'failed' | 'context_blocked',
            run.locale,
            run.presentation?.verification?.reason
          )
      sink.state(
        signal.aborted
          ? { kind: 'aborted', message: workbenchMainText('conversation.runStopped') }
          : { kind: 'error', message }
      )
      outcome(signal.aborted ? 'cancelled' : 'failed', message)
      if (!admitted) throw failure ?? new AppError('VALIDATION', message)
      return
    }
    if (signal.aborted || status === 'cancelled') {
      sink.state({ kind: 'aborted', message: workbenchMainText('conversation.runStopped') })
      outcome('cancelled', workbenchMainText('conversation.runStopped'))
    } else if (status === 'completed') {
      sink.state(conversationDone({ goal, startedAt }))
      outcome('completed', null)
    } else {
      const notice = run.presentation?.notice
      sink.state({
        kind: 'aborted',
        message:
          notice?.kind === 'stalled'
            ? stalledMessage(notice.repeatedSteps, run.locale)
            : workbenchMainText('conversation.waitingForInput'),
      })
      outcome(
        'waiting',
        notice?.kind === 'stalled'
          ? stalledMessage(notice.repeatedSteps, run.locale)
          : workbenchMainText('conversation.waitingForInput')
      )
    }
  }

  /** 项目规则读不到（没有规则、项目不可读）不拦这一轮，只是不附。 */
  private async readProjectRules(projectRoot: string): Promise<readonly ConversationProjectRule[]> {
    try {
      return (await this.options.projectRules?.(projectRoot)) ?? []
    } catch (error) {
      log.warn('读不到项目 AI 规则，这一轮不附', { error: AppError.getMessage(error) })
      return []
    }
  }

  /** 在回合边界和关闭前读取追踪；观察失败不改变已发生的执行结果。 */
  private async projectTrace(
    { text, scripts, agents, commandOutput }: ConversationTraceBoards,
    run: ActiveConversationRun,
    runId: string,
    turnId: string,
    final: boolean
  ): Promise<void> {
    const session = run.handle?.session
    if (!session) return
    try {
      const trace = await session.trace(turnId)
      if (final && trace.gaps?.length)
        text.settle({
          id: `conversation:trace-gaps:${turnId}`,
          runId,
          turnId,
          phase: 'accepted',
          text: workbenchMainText('conversation.traceGaps'),
        })
      scripts.trace(trace)
      agents.trace(trace, (executionId) => scripts.cardOf(executionId))
      if (run.handle?.trace) await agents.refresh(run.handle.trace)
      commandOutput.settle(trace)
    } catch (error) {
      log.warn('执行记录读取失败', { turnId, error: AppError.getMessage(error) })
      if (final)
        text.settle({
          id: `conversation:trace-error:${turnId}`,
          runId,
          turnId,
          phase: 'accepted',
          text: workbenchMainText('conversation.traceUnreadable'),
        })
    }
  }

  private project(
    sink: WorkbenchConversationSink,
    text: ConversationTextBoard,
    run: ActiveConversationRun,
    event: ConversationSessionEvent
  ): void {
    const previous = run.projector?.snapshot()
    const prior = previous?.runs[event.runId]
    if (run.projector && previous) {
      const next = run.projector.applyLive(event)
      run.presentation = next.runs[event.runId]
      this.projectText(text, previous, next)
    }
    switch (event.type) {
      case 'input-applied':
        if (event.inputId) sink.state({ kind: 'input-applied', inputId: event.inputId })
        break
      case 'turn':
        if (run.presentation?.turn === prior?.turn) break
        sink.state({ kind: 'turn-start', turn: run.presentation?.turn ?? 0 })
        break
      case 'accepted':
        if (run.presentation?.messages.length === prior?.messages.length) break
        sink.state({ kind: 'turn-end', turn: run.presentation?.turn ?? 0 })
        break
      case 'interaction':
        this.interactions.get(run)?.open(event.runId, event.request)
        sink.state(awaitingState(event.runId, event.request))
        break
      case 'answer':
        sink.state({ kind: 'phase', teamPhase: 'executing' })
        break
      case 'throttled':
        sink.state({
          kind: 'reconnecting',
          attempt: 1,
          message: throttledMessage(event.retryAfterMs, run.locale),
        })
        break
      case 'state':
        if (event.status === 'thinking' || event.status === 'executing')
          sink.state({
            kind: 'phase',
            teamPhase: event.status === 'thinking' ? 'researching' : 'executing',
          })
        break
      case 'usage':
        if (run.modelLimits)
          sink.state(
            contextUsageFromProvider({
              turn: run.presentation?.turn ?? 0,
              model: run.modelId ?? '',
              inputTokens: event.inputTokens,
              limits: run.modelLimits,
              timestamp: Date.now(),
            })
          )
        break
    }
  }

  /** 将 Platform 展示快照映射为界面消息身份，不自行解释正文接纳或拼接增量。 */
  private projectText(
    text: ConversationTextBoard,
    previous: ActPresentation,
    next: ActPresentation
  ): void {
    for (const [runId, current] of Object.entries(next.runs)) {
      const prior = previous.runs[runId]
      if (
        prior?.preview &&
        prior.turnId &&
        (!current.preview || current.turnId !== prior.turnId) &&
        !current.messages.some((message) => message.turnId === prior.turnId)
      )
        text.settle({
          id: `conversation:${runId}:${prior.turnId}`,
          runId,
          turnId: prior.turnId,
          phase: 'rejected',
          text: '',
        })
      if (
        current.preview &&
        current.turnId &&
        (current.preview !== prior?.preview || current.turnId !== prior?.turnId)
      )
        text.preview({
          id: `conversation:${runId}:${current.turnId}`,
          runId,
          turnId: current.turnId,
          phase: 'preview',
          text: current.preview,
        })
      for (const message of current.messages) {
        if (prior?.messages.some((item) => item.turnId === message.turnId)) continue
        text.settle({
          id: `conversation:${runId}:${message.turnId}`,
          runId,
          turnId: message.turnId,
          phase: 'accepted',
          text: message.text,
        })
      }
    }
  }
}

/**
 * 模型不收图时，图片不随输入发出（发了会被服务商拒掉整轮），正文后面说明一句，模型知道用户附过图。
 */
function withoutImages(
  input: ConversationInput,
  locale: WorkbenchConversationSendRequest['locale']
): ConversationInput {
  const count = input.images?.length ?? 0
  if (!count) return input
  const note =
    locale === 'en-US'
      ? `(The user attached ${count} image(s), but the current model cannot view images, so they were not sent.)`
      : `（用户附了 ${count} 张图片，当前模型不能看图，没有随消息发出。）`
  return { ...input, images: undefined, text: [input.text, note].filter(Boolean).join('\n\n') }
}

/** 运行按 (项目根, 会话) 认。 */
function runKey(ref: WorkbenchConversationRef): string {
  return `${resolve(ref.projectRoot)}\0${ref.sessionId}`
}

/** 创建主聊天的 Platform 会话控制面。 */
export function createWorkbenchConversationRuntime(
  options: WorkbenchConversationRuntimeOptions
): WorkbenchConversationRuntimeApi {
  return new WorkbenchConversationRuntime(options)
}
