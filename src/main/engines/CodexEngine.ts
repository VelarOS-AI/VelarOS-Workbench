import type { AppLocale, ReasoningLevel } from '@velaros-ai/ui/conversation/contracts'
import {
  isArray,
  isFiniteNumber,
  isNonBlankString,
  isPlainObject,
  isString,
  Log,
  optionalWhen,
} from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchAgentEngineModel,
  WorkbenchAgentEngineStatus,
  WorkbenchConversationImage,
  WorkbenchPermissionConfirmationMode,
} from '../../shared/workbenchConversation'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import { CodexAppServerClient, type CodexServerRequest } from './CodexAppServerClient'
import { engineInstructions } from './WorkbenchEngineInstructions'
import {
  displayPath,
  type EngineAction,
  engineConfirmation,
  oneLine,
  projectRelativePaths,
} from './WorkbenchEnginePermissions'
import {
  engineFailure,
  resolveEngineCommand,
  withTimeout,
  type WorkbenchEngineEnvironmentSource,
} from './WorkbenchEngineProcess'
import type { EngineRunSurface } from './WorkbenchEngineRunSurface'
import type {
  WorkbenchAgentEngine,
  WorkbenchEngineRunInput,
  WorkbenchEngineRunResult,
} from './WorkbenchEngineTypes'

const log = Log.tag('CodexEngine')

/** 起 app-server、探模型与账号最多等这么久。 */
const StatusTimeoutMs = 20_000
/** 停下时请 Codex 打断这一回合；这么久还没收尾就按已停止了结。 */
const InterruptGraceMs = 5_000
const TitleChars = 160
/** 没有回合在跑这么久，就停下常驻的 app-server；下次用到再起（起一次不到一秒）。 */
const IdleCloseMs = 5 * 60_000
/** 思考力度从低到高；模型不支持所选的档时取它支持的、不超过所选的最高一档。 */
const EffortOrder: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

interface CodexActiveRun {
  readonly input: WorkbenchEngineRunInput
  readonly threadId: string
  readonly translator: CodexTranslator
  turnId: Nullable<string>
  settled: boolean
  /** 最近一次不再重试的错误；回合以失败收尾时用它说明原因。 */
  lastError?: string
  settle(outcome: { status: 'completed' | 'aborted' } | { error: unknown }): void
}

/**
 * Codex 引擎：起本机装好的 `codex app-server`（一个进程跑所有会话，每个 Workbench 会话一条 thread），走它的
 * JSON-RPC 协议。登录、模型、工具、AGENTS.md 与会话记录都归 Codex；Workbench 把回答、命令、改文件画进对话，
 * 按 Workbench 的权限档回答它的审批请求，把它的提问变成提问卡。
 */
export class CodexEngine implements WorkbenchAgentEngine {
  public readonly id = 'codex' as const
  public readonly label = 'Codex'
  private client?: Promise<CodexAppServerClient>
  private readonly runs = new Map<string, CodexActiveRun>()
  /** 最近一次探到的各模型支持的思考力度。 */
  private readonly efforts = new Map<string, readonly string[]>()
  /** 在等宿主回答的请求：Codex 自己了结（serverRequest/resolved）时撤下卡片。 */
  private readonly requests = new Map<string, AbortController>()
  private idleTimer?: ReturnType<typeof setTimeout>

  public constructor(
    private readonly environment: WorkbenchEngineEnvironmentSource,
    private readonly clientVersion: string
  ) {}

  public async status(signal?: AbortSignal): Promise<WorkbenchAgentEngineStatus> {
    try {
      const client = await withTimeout(
        this.connect(),
        StatusTimeoutMs,
        workbenchMainText('engines.codexNoResponse'),
        signal
      )
      const [account, models] = await withTimeout(
        Promise.all([client.request('account/read', {}), this.listModels(client)]),
        StatusTimeoutMs,
        workbenchMainText('engines.codexNoResponse'),
        signal
      )
      if (
        isPlainObject(account) &&
        account.requiresOpenaiAuth === true &&
        !isPlainObject(account.account)
      )
        return {
          id: this.id,
          available: false,
          problem: 'signed-out',
          reason: workbenchMainText('engines.codexSignedOut'),
          models,
        }
      if (models.length === 0)
        return {
          id: this.id,
          available: false,
          problem: 'error',
          reason: workbenchMainText('engines.codexNoModels'),
          models,
        }
      return { id: this.id, available: true, models }
    } catch (error) {
      return engineFailure(this.id, error)
    } finally {
      this.scheduleIdleClose()
    }
  }

  public async run(input: WorkbenchEngineRunInput): Promise<WorkbenchEngineRunResult> {
    const { signal, ref } = input
    const client = await withTimeout(
      this.connect(),
      StatusTimeoutMs,
      workbenchMainText('engines.codexNoResponse'),
      signal
    )
    const permissions = codexPermissions(input.permissionMode, ref.projectRoot)
    const settings = {
      cwd: ref.projectRoot,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: 'user',
      sandbox: permissions.sandbox,
      developerInstructions: engineInstructions(input.executionModes, input.locale),
      model: input.model,
    }
    let threadId: Nullable<string> = null
    if (input.resume) {
      try {
        threadId = readThreadId(
          await client.request('thread/resume', { threadId: input.resume, ...settings })
        )
      } catch (error) {
        signal.throwIfAborted()
        log.info('Codex 接不上上一轮的 thread，另开一条', { error: AppError.getMessage(error) })
      }
      if (!threadId) input.sessionLost()
    }
    threadId ??= readThreadId(
      await client.request('thread/start', { ...settings, ephemeral: false })
    )
    if (!threadId) throw new AppError('PROTOCOL', workbenchMainText('engines.codexNoThread'))
    input.sessionStarted(threadId)
    signal.throwIfAborted()
    await this.applyGoal(client, threadId, input)

    let resolveOutcome!: (value: WorkbenchEngineRunResult) => void
    let rejectOutcome!: (error: unknown) => void
    const outcome = new Promise<WorkbenchEngineRunResult>((resolve, reject) => {
      resolveOutcome = resolve
      rejectOutcome = reject
    })
    // 回合开不出来时没人等它：失败由下面的 catch 交出去。
    void outcome.catch(() => undefined)
    const run: CodexActiveRun = {
      input,
      threadId,
      translator: new CodexTranslator(input.surface, ref.projectRoot, input.locale),
      turnId: null,
      settled: false,
      settle: (result) => {
        if (run.settled) return
        run.settled = true
        this.runs.delete(threadId)
        if ('error' in result) rejectOutcome(result.error)
        else resolveOutcome(result)
      },
    }
    this.runs.set(threadId, run)
    const stop = (): void => {
      const interrupt = (turnId: string): void => {
        void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      }
      if (run.turnId) interrupt(run.turnId)
      setTimeout(() => run.settle({ status: 'aborted' }), InterruptGraceMs).unref()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      const effort = codexEffort(
        input.reasoningLevel,
        input.model ? this.efforts.get(input.model) : undefined
      )
      const turn = await client.request('turn/start', {
        threadId,
        input: userInput(input.text, input.images),
        cwd: ref.projectRoot,
        approvalPolicy: permissions.approvalPolicy,
        sandboxPolicy: permissions.sandboxPolicy,
        model: input.model,
        effort,
      })
      const turnId =
        isPlainObject(turn) && isPlainObject(turn.turn) && isNonBlankString(turn.turn.id)
          ? turn.turn.id
          : null
      run.turnId ??= turnId
      input.accepted()
      // 回合开出来之前就按了停止：现在才有回合可打断。
      if (signal.aborted && run.turnId)
        void client
          .request('turn/interrupt', { threadId, turnId: run.turnId })
          .catch(() => undefined)
      return await outcome
    } catch (error) {
      run.settle({ error })
      if (signal.aborted) return { status: 'aborted' }
      throw error
    } finally {
      signal.removeEventListener('abort', stop)
      this.runs.delete(threadId)
      this.scheduleIdleClose()
    }
  }

  public async close(): Promise<void> {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const client = this.client
    this.client = undefined
    if (!client) return
    try {
      ;(await client).close()
    } catch {
      // 没起来的进程不用停。
    }
  }

  /** 常驻的 app-server：第一次用时起，闲下来或退出了下次再起。 */
  private connect(): Promise<CodexAppServerClient> {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.client) return this.client
    const starting = (async () => {
      const command = await resolveEngineCommand(this.environment, 'codex', this.label)
      return CodexAppServerClient.start(command, this.clientVersion, {
        notification: (method, params) => this.notification(method, params),
        request: (request) => this.request(request),
        closed: (error) => {
          if (this.client === starting) this.client = undefined
          for (const run of [...this.runs.values()]) run.settle({ error })
        },
      })
    })()
    this.client = starting
    starting.catch(() => {
      if (this.client === starting) this.client = undefined
    })
    return starting
  }

  /** 没有回合在跑时，过一阵停下 app-server：不用 Codex 的人不必一直开着它。 */
  private scheduleIdleClose(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.runs.size > 0 || !this.client) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.runs.size === 0) void this.close()
    }, IdleCloseMs)
    this.idleTimer.unref()
  }

  private async listModels(client: CodexAppServerClient): Promise<WorkbenchAgentEngineModel[]> {
    const response = await client.request('model/list', { includeHidden: false })
    const entries =
      isPlainObject(response) && isArray(response.data) ? response.data.filter(isPlainObject) : []
    this.efforts.clear()
    return entries.flatMap((entry) => {
      const value = [entry.model, entry.id].find(isNonBlankString)
      if (!value) return []
      const efforts = isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts.flatMap((option) =>
            isPlainObject(option) && isNonBlankString(option.reasoningEffort)
              ? [option.reasoningEffort]
              : []
          )
        : []
      this.efforts.set(value, efforts)
      return [
        {
          value,
          label: isNonBlankString(entry.displayName) ? entry.displayName : value,
          description: optionalWhen(isNonBlankString, entry.description),
          isDefault: optionalWhen(entry.isDefault === true, true),
        },
      ]
    })
  }

  /** 目标模式交给 Codex 自己的目标；没开时清掉上一轮留下的。旧版本没有目标接口时照常跑。 */
  private async applyGoal(
    client: CodexAppServerClient,
    threadId: string,
    input: WorkbenchEngineRunInput
  ): Promise<void> {
    try {
      if (input.executionModes.includes('goal') && input.text.trim())
        await client.request('thread/goal/set', {
          threadId,
          objective: input.text,
          status: 'active',
        })
      else await client.request('thread/goal/clear', { threadId })
    } catch (error) {
      log.debug('Codex 的目标没设上', { error: AppError.getMessage(error) })
    }
  }

  private notification(method: string, params: Record<string, unknown>): void {
    const threadId = isString(params.threadId) ? params.threadId : undefined
    if (method === 'serverRequest/resolved') {
      const key = `${String(threadId)}\0${String(params.requestId)}`
      this.requests
        .get(key)
        ?.abort(new AppError('CANCELLED', workbenchMainText('engines.codexRequestWithdrawn')))
      return
    }
    const run = threadId ? this.runs.get(threadId) : undefined
    if (!run) return
    switch (method) {
      case 'turn/started':
        if (isPlainObject(params.turn) && isNonBlankString(params.turn.id))
          run.turnId ??= params.turn.id
        return
      case 'turn/completed': {
        const turn = isPlainObject(params.turn) ? params.turn : {}
        if (run.turnId && turn.id !== run.turnId) return
        if (turn.status === 'failed') {
          const error =
            isPlainObject(turn.error) && isNonBlankString(turn.error.message)
              ? turn.error.message
              : run.lastError
          run.settle({
            error: new AppError(
              'UNAVAILABLE',
              error ?? workbenchMainText('engines.codexRunIncomplete')
            ),
          })
        } else run.settle({ status: turn.status === 'interrupted' ? 'aborted' : 'completed' })
        return
      }
      case 'error': {
        const message =
          isPlainObject(params.error) && isNonBlankString(params.error.message)
            ? params.error.message
            : undefined
        if (params.willRetry === true)
          run.input.surface.reconnecting(message ?? workbenchMainText('engines.codexRetrying'))
        else if (message) run.lastError = message
        return
      }
      default:
        run.translator.notification(method, params)
    }
  }

  /** app-server 问宿主的请求：审批按 Workbench 的权限档，提问变成提问卡，其余一律拒绝。 */
  private async request(request: CodexServerRequest): Promise<unknown> {
    const { params } = request
    const threadId = [params.threadId, params.conversationId].find(isString)
    const run = threadId ? this.runs.get(threadId) : undefined
    const legacy =
      request.method === 'applyPatchApproval' || request.method === 'execCommandApproval'
    const refuse = (): unknown => {
      if (request.method === 'item/tool/requestUserInput') return { answers: {} }
      if (request.method === 'item/permissions/requestApproval')
        return { permissions: {}, scope: 'turn' }
      if (request.method === 'mcpServer/elicitation/request')
        return { action: 'cancel', content: null, _meta: null }
      if (legacy) return { decision: { denied: { rejection: 'Workbench 会话已经结束。' } } }
      return { decision: 'decline' }
    }
    if (!run) {
      if (isApproval(request.method) || legacy || request.method === 'item/tool/requestUserInput')
        return refuse()
      throw new AppError(
        'PROTOCOL',
        workbenchMainText('engines.unhandledRequest', { request: request.method })
      )
    }
    const key = `${threadId}\0${String(request.id)}`
    const controller = new AbortController()
    this.requests.set(key, controller)
    const signal = AbortSignal.any([controller.signal, run.input.signal])
    try {
      switch (request.method) {
        case 'item/commandExecution/requestApproval':
        case 'execCommandApproval':
          return approvalDecision(
            await this.approve(run, commandAction(params, run.input.ref.projectRoot), signal),
            legacy
          )
        case 'item/fileChange/requestApproval':
        case 'applyPatchApproval':
          return approvalDecision(
            await this.approve(
              run,
              {
                kind: 'edit',
                paths: run.translator.fileChangePaths(params),
                reason: stringOf(params.reason),
              },
              signal
            ),
            legacy
          )
        case 'item/permissions/requestApproval':
          return (await this.approve(
            run,
            { kind: 'other', name: 'Codex', detail: permissionSummary(params, run.input.locale) },
            signal,
            true
          ))
            ? {
                permissions: isPlainObject(params.permissions) ? params.permissions : {},
                scope: 'turn',
              }
            : { permissions: {}, scope: 'turn' }
        case 'item/tool/requestUserInput':
          return { answers: await askQuestions(run.input.surface, params.questions, signal) }
        default:
          return refuse()
      }
    } catch (error) {
      if (signal.aborted) return refuse()
      throw error
    } finally {
      if (this.requests.get(key) === controller) this.requests.delete(key)
    }
  }

  /** 按权限档决定要不要问；`always` 表示这件事无论哪一档（从不询问除外）都要问。 */
  private async approve(
    run: CodexActiveRun,
    action: EngineAction,
    signal: AbortSignal,
    always = false
  ): Promise<boolean> {
    const { permissionMode, ref, locale } = run.input
    const confirmation = engineConfirmation(
      always && permissionMode === 'standard-open' ? 'ask-every-time' : permissionMode,
      action,
      ref.projectRoot,
      locale
    )
    if (!confirmation) return true
    return (await run.input.surface.confirm(confirmation, signal)).approved
  }
}

/**
 * 把一个回合的通知画进对话：正文与思考逐字到，命令、改文件、外部工具各一张工具卡，计划更新成计划卡。
 */
class CodexTranslator {
  /** 改文件那一步要写的文件（审批请求不带路径，按这一步找）。 */
  private readonly fileChanges = new Map<string, string[]>()
  private readonly planIds = new Set<string>()

  public constructor(
    private readonly surface: EngineRunSurface,
    private readonly projectRoot: string,
    private readonly locale: AppLocale
  ) {}

  public fileChangePaths(params: Record<string, unknown>): string[] {
    return isString(params.itemId) ? (this.fileChanges.get(params.itemId) ?? []) : []
  }

  public notification(method: string, params: Record<string, unknown>): void {
    const itemId = isString(params.itemId) ? params.itemId : ''
    switch (method) {
      case 'item/agentMessage/delta':
        if (isString(params.delta)) this.surface.appendText(itemId, params.delta)
        this.surface.phase('researching')
        return
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (isString(params.delta)) this.surface.appendThinking(itemId, params.delta)
        this.surface.phase('researching')
        return
      case 'item/reasoning/summaryPartAdded':
        if (isFiniteNumber(params.summaryIndex) && params.summaryIndex > 0)
          this.surface.appendThinking(itemId, '\n\n')
        return
      case 'item/commandExecution/outputDelta':
        if (isString(params.delta)) this.surface.toolProgress(itemId, params.delta)
        return
      case 'item/started':
        if (isPlainObject(params.item)) this.started(params.item)
        return
      case 'item/completed':
        if (isPlainObject(params.item)) this.completed(params.item)
        return
      case 'turn/plan/updated':
        this.plan(params)
        return
    }
  }

  private started(item: Record<string, unknown>): void {
    const id = isNonBlankString(item.id) ? item.id : null
    if (!id) return
    const zh = this.locale !== 'en-US'
    switch (item.type) {
      case 'commandExecution':
        this.surface.startTool({
          id,
          toolName: 'project:run',
          title: oneLine(stringOf(item.command) ?? '', TitleChars),
          args: { command: item.command, cwd: item.cwd },
        })
        this.surface.beginProjectActivity(id)
        break
      case 'fileChange': {
        const changes = isArray(item.changes) ? item.changes.filter(isPlainObject) : []
        const paths = changes.flatMap((change) => [
          ...(isNonBlankString(change.path) ? [change.path] : []),
          ...(isPlainObject(change.kind) && isNonBlankString(change.kind.move_path)
            ? [change.kind.move_path]
            : []),
        ])
        this.fileChanges.set(id, paths)
        this.surface.startTool({
          id,
          toolName: 'project:edit',
          title:
            `${zh ? '编辑' : 'Edit'} ${oneLine(paths.map((path) => displayPath(this.projectRoot, path)).join(zh ? '、' : ', '), TitleChars)}`.trim(),
          args: { changes },
        })
        this.surface.beginProjectActivity(id)
        break
      }
      case 'mcpToolCall':
        this.surface.startTool({
          id,
          toolName: `mcp:${String(item.server)}/${String(item.tool)}`,
          title: `${String(item.server)} · ${String(item.tool)}`,
          args: isPlainObject(item.arguments) ? item.arguments : { arguments: item.arguments },
        })
        break
      case 'dynamicToolCall':
        this.surface.startTool({
          id,
          toolName: String(item.tool),
          title: String(item.tool),
          args: isPlainObject(item.arguments) ? item.arguments : { arguments: item.arguments },
        })
        break
      case 'webSearch':
        this.surface.startTool({
          id,
          toolName: 'web:search',
          title:
            `${zh ? '搜索网页' : 'Search the web'} ${oneLine(stringOf(item.query) ?? '', TitleChars)}`.trim(),
          args: { query: item.query },
        })
        break
      case 'imageView':
        this.surface.startTool({
          id,
          toolName: 'project:read',
          title:
            `${zh ? '查看图片' : 'View image'} ${displayPath(this.projectRoot, stringOf(item.path) ?? '')}`.trim(),
          args: { path: item.path },
        })
        break
      case 'collabAgentToolCall':
        this.surface.startTool({
          id,
          toolName: 'agent:dispatch',
          title: oneLine(stringOf(item.prompt) ?? String(item.tool), TitleChars),
          args: { tool: item.tool, prompt: item.prompt, model: item.model },
        })
        break
      default:
        return
    }
    this.surface.phase('executing')
  }

  private completed(item: Record<string, unknown>): void {
    const id = isNonBlankString(item.id) ? item.id : null
    if (!id) return
    const zh = this.locale !== 'en-US'
    switch (item.type) {
      case 'agentMessage':
        this.surface.finishText(id, isString(item.text) ? item.text : undefined)
        return
      case 'commandExecution': {
        const exitCode = isFiniteNumber(item.exitCode) ? item.exitCode : null
        const output = stringOf(item.aggregatedOutput) ?? ''
        const result = { exitCode, output, durationMs: item.durationMs }
        this.surface.finishTool(
          id,
          item.status === 'declined'
            ? { error: zh ? '用户拒绝了这条命令。' : 'The user declined this command.' }
            : item.status === 'failed'
              ? {
                  result,
                  error:
                    exitCode === null
                      ? output || (zh ? '命令没有跑完。' : 'The command did not finish.')
                      : `${zh ? '退出码' : 'Exit code'} ${exitCode}`,
                }
              : { result }
        )
        this.surface.endProjectActivity(id)
        return
      }
      case 'fileChange': {
        const paths = this.fileChanges.get(id) ?? []
        const ok = item.status === 'completed'
        this.surface.finishTool(
          id,
          ok
            ? { result: { files: paths.map((path) => displayPath(this.projectRoot, path)) } }
            : {
                error:
                  item.status === 'declined'
                    ? zh
                      ? '用户拒绝了这次修改。'
                      : 'The user declined this change.'
                    : zh
                      ? '修改没有写进去。'
                      : 'The change was not applied.',
              }
        )
        this.surface.endProjectActivity(id, ok ? projectRelativePaths(this.projectRoot, paths) : [])
        return
      }
      case 'mcpToolCall':
        this.surface.finishTool(
          id,
          isPlainObject(item.error) && isNonBlankString(item.error.message)
            ? { error: item.error.message }
            : { result: item.result }
        )
        return
      case 'dynamicToolCall':
        this.surface.finishTool(
          id,
          item.success === false
            ? { error: zh ? '工具调用失败。' : 'The tool call failed.', result: item.contentItems }
            : { result: item.contentItems }
        )
        return
      case 'webSearch':
      case 'imageView':
      case 'collabAgentToolCall':
        this.surface.finishTool(
          id,
          item.status === 'failed'
            ? { error: zh ? '没有完成。' : 'Did not complete.' }
            : { result: item }
        )
        return
    }
  }

  /** 计划更新：一个回合一张计划卡，原位换成最新的步骤。 */
  private plan(params: Record<string, unknown>): void {
    const turnId = isNonBlankString(params.turnId) ? params.turnId : 'turn'
    const id = `${turnId}:plan`
    const plan = (isArray(params.plan) ? params.plan.filter(isPlainObject) : []).flatMap((step) =>
      isNonBlankString(step.step)
        ? [
            {
              step: step.step,
              status: step.status === 'inProgress' ? 'in_progress' : String(step.status),
            },
          ]
        : []
    )
    const args = { explanation: optionalWhen(isNonBlankString, params.explanation), plan }
    const title = this.locale !== 'en-US' ? '更新计划' : 'Update plan'
    if (this.planIds.has(id)) this.surface.updateTool(id, { args, result: args })
    else {
      this.planIds.add(id)
      this.surface.startTool({ id, toolName: 'plan:update', title, args })
      this.surface.finishTool(id, { result: args })
    }
  }
}

function codexPermissions(
  mode: WorkbenchPermissionConfirmationMode,
  projectRoot: string
): { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> } {
  if (mode === 'never-ask')
    return {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }
  return {
    // 标准档：沙箱里随便跑，要出沙箱（联网之外的越界写、改 .git）才问，问到时按 Workbench 的危险命令规则答。
    // 每次都问：除了只读的命令都问。
    approvalPolicy: mode === 'ask-every-time' ? 'untrusted' : 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [projectRoot],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  }
}

function codexEffort(
  level: ReasoningLevel,
  supported: Nullable<readonly string[]> | undefined
): string | undefined {
  if (!supported?.length) return undefined
  if (supported.includes(level)) return level
  const ceiling = EffortOrder.indexOf(level)
  const within = supported.filter((effort) => {
    const rank = EffortOrder.indexOf(effort)
    return rank >= 0 && rank <= ceiling
  })
  return (
    within.sort((left, right) => EffortOrder.indexOf(left) - EffortOrder.indexOf(right)).at(-1) ??
    supported[0]
  )
}

function userInput(text: string, images: readonly WorkbenchConversationImage[]): unknown[] {
  return [
    ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
    ...images.map((image) => ({
      type: 'image',
      url: `data:${image.mediaType};base64,${image.data}`,
    })),
  ]
}

function readThreadId(value: unknown): Nullable<string> {
  return isPlainObject(value) && isPlainObject(value.thread) && isNonBlankString(value.thread.id)
    ? value.thread.id
    : null
}

function isApproval(method: string): boolean {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval'
  )
}

function approvalDecision(approved: boolean, legacy: boolean): unknown {
  if (legacy)
    return { decision: approved ? 'approved' : { denied: { rejection: '用户拒绝了这次操作。' } } }
  return { decision: approved ? 'accept' : 'decline' }
}

function commandAction(params: Record<string, unknown>, projectRoot: string): EngineAction {
  const command = isArray(params.command)
    ? params.command.filter(isString).join(' ')
    : (stringOf(params.command) ?? '')
  return {
    kind: 'command',
    command,
    cwd: stringOf(params.cwd) ?? projectRoot,
    reason: stringOf(params.reason),
  }
}

function permissionSummary(params: Record<string, unknown>, locale: AppLocale): string {
  const zh = locale !== 'en-US'
  const permissions = isPlainObject(params.permissions) ? params.permissions : {}
  const parts = [
    ...(isPlainObject(permissions.network) ? [zh ? '联网' : 'network access'] : []),
    ...(isPlainObject(permissions.fileSystem) ? [zh ? '额外的文件读写' : 'extra file access'] : []),
  ]
  const reason = stringOf(params.reason)
  return [
    zh
      ? `申请${parts.join('、') || '额外权限'}`
      : `requests ${parts.join(', ') || 'extra permissions'}`,
    reason,
  ]
    .filter(Boolean)
    .join(zh ? '：' : ': ')
}

/** request_user_input：一题一张卡，依次问；回答按 Codex 认的形状（题号 → 选中的文字）。 */
async function askQuestions(
  surface: EngineRunSurface,
  value: unknown,
  signal: AbortSignal
): Promise<Record<string, { answers: string[] }>> {
  const questions = isArray(value) ? value.filter(isPlainObject) : []
  const answers: Record<string, { answers: string[] }> = {}
  for (const [index, question] of questions.entries()) {
    const text = stringOf(question.question)
    if (!text) continue
    const options = (
      isArray(question.options) ? question.options.filter(isPlainObject) : []
    ).flatMap((option) =>
      isNonBlankString(option.label)
        ? [{ label: option.label, description: optionalWhen(isNonBlankString, option.description) }]
        : []
    )
    const header = stringOf(question.header)
    const answer = await surface.ask(
      {
        question: header ? `${header}\n${text}` : text,
        options,
        allowText: question.isOther === true || options.length === 0,
      },
      signal
    )
    if (answer.declined) continue
    answers[stringOf(question.id) ?? `q${index}`] = {
      answers: [...answer.choices, ...(answer.text ? [answer.text] : [])],
    }
  }
  return answers
}

function stringOf(value: unknown): string | undefined {
  return isNonBlankString(value) ? value : undefined
}
