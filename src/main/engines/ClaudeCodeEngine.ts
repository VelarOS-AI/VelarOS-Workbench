import { homedir } from 'node:os'

import {
  isArray,
  isFiniteNumber,
  isNonBlankString,
  isPlainObject,
  isString,
  Log,
  optionalWhen,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { AppLocale } from '@velaros-ai/ui/conversation/contracts'

import type {
  WorkbenchAgentEngineModel,
  WorkbenchAgentEngineStatus,
  WorkbenchConversationImage,
} from '../../shared/workbenchConversation'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import {
  type ClaudeCodeControlRequest,
  type ClaudeCodeMessage,
  ClaudeCodeProtocolArgs,
  ClaudeCodeTransport,
} from './ClaudeCodeTransport'
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
  runEngineCommand,
  withTimeout,
  type WorkbenchEngineCommand,
  type WorkbenchEngineEnvironmentSource,
} from './WorkbenchEngineProcess'
import type { EngineRunSurface } from './WorkbenchEngineRunSurface'
import type {
  WorkbenchAgentEngine,
  WorkbenchEngineRunInput,
  WorkbenchEngineRunResult,
} from './WorkbenchEngineTypes'

const log = Log.tag('ClaudeCodeEngine')

/** 探模型目录、查登录最多等这么久。 */
const StatusTimeoutMs = 20_000
/** 停下时先请命令行打断这一回合；这么久还没退出就直接结束进程。 */
const InterruptGraceMs = 3_000
/** 工具卡标题里的命令、路径最多这么长。 */
const TitleChars = 160

/** 写文件的工具：参数里带路径，跑完告诉语言服务。 */
const EditTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** 上一轮留下的会话在命令行那边接不上了：另开一段再跑。 */
class ClaudeCodeResumeLost extends Error {}

/**
 * Claude Code 引擎：直接起本机装好的 `claude` 命令行，走它的 stream-json 协议（与官方 Agent SDK 同一套），
 * 不打包 SDK。登录、模型、工具、CLAUDE.md 与会话记录都归命令行自己；Workbench 负责把回答、工具调用画进对话，
 * 按 Workbench 的权限档回答它的工具权限请求，把它的提问变成提问卡。一轮一个进程，下一轮带 `--resume` 接着同一段会话。
 */
export class ClaudeCodeEngine implements WorkbenchAgentEngine {
  public readonly id = 'claude-code' as const
  public readonly label = 'Claude Code'
  /** 最近一次探到的、能调思考力度的模型。 */
  private readonly effortModels = new Set<string>()
  private readonly running = new Set<ClaudeCodeTransport>()

  public constructor(private readonly environment: WorkbenchEngineEnvironmentSource) {}

  public async status(signal?: AbortSignal): Promise<WorkbenchAgentEngineStatus> {
    try {
      const command = await resolveEngineCommand(this.environment, 'claude', this.label, signal)
      const [models, loggedIn] = await Promise.all([
        this.probeModels(command, signal),
        readLoginState(command, signal),
      ])
      if (loggedIn === false)
        return {
          id: this.id,
          available: false,
          problem: 'signed-out',
          reason: workbenchMainText('engines.claudeSignedOut'),
          models,
        }
      if (models.length === 0)
        return {
          id: this.id,
          available: false,
          problem: 'error',
          reason: workbenchMainText('engines.claudeNoModels'),
          models,
        }
      return { id: this.id, available: true, models }
    } catch (error) {
      return engineFailure(this.id, error)
    }
  }

  public async run(input: WorkbenchEngineRunInput): Promise<WorkbenchEngineRunResult> {
    const command = await resolveEngineCommand(this.environment, 'claude', this.label, input.signal)
    try {
      return await this.runOnce(command, input, input.resume)
    } catch (error) {
      if (!(error instanceof ClaudeCodeResumeLost)) throw error
      log.info('Claude Code 接不上上一轮的会话，另开一段', { sessionId: input.ref.sessionId })
      input.sessionLost()
      return this.runOnce(command, input, null)
    }
  }

  public async close(): Promise<void> {
    for (const transport of this.running) transport.close()
    await Promise.allSettled([...this.running].map((transport) => transport.exited))
  }

  private async probeModels(
    command: WorkbenchEngineCommand,
    signal?: AbortSignal
  ): Promise<WorkbenchAgentEngineModel[]> {
    const transport = ClaudeCodeTransport.start(command, ClaudeCodeProtocolArgs, homedir())
    try {
      const init = await withTimeout(
        transport.initialize(),
        StatusTimeoutMs,
        workbenchMainText('engines.claudeNoResponse'),
        signal
      )
      const { models, effort } = readClaudeModels(init.models)
      this.effortModels.clear()
      for (const model of effort) this.effortModels.add(model)
      return models
    } finally {
      transport.close()
    }
  }

  private async runOnce(
    command: WorkbenchEngineCommand,
    input: WorkbenchEngineRunInput,
    resume: Nullable<string>
  ): Promise<WorkbenchEngineRunResult> {
    const { signal, surface } = input
    signal.throwIfAborted()
    const args = [
      ...ClaudeCodeProtocolArgs,
      '--include-partial-messages',
      // 工具权限一律经控制通道问 Workbench，按 Workbench 的权限档回答（见 permission）。
      '--permission-mode',
      'default',
      '--setting-sources',
      'user,project,local',
      '--append-system-prompt',
      engineInstructions(input.executionModes, input.locale),
    ]
    if (input.model) args.push('--model', input.model)
    if (input.model && this.effortModels.has(input.model))
      args.push('--effort', input.reasoningLevel)
    if (resume) args.push('--resume', resume)
    const transport = ClaudeCodeTransport.start(command, args, input.ref.projectRoot, (request) =>
      this.permission(input, request)
    )
    this.running.add(transport)
    const translator = new ClaudeCodeTranslator(surface, input.ref.projectRoot, input.locale)
    let started = false
    let result: Nullable<ClaudeCodeMessage> = null
    const stop = (): void => {
      void transport.interrupt().catch(() => transport.close())
      setTimeout(() => transport.close(), InterruptGraceMs).unref()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      await transport.initialize()
      signal.throwIfAborted()
      transport.sendUser(userContent(input.text, input.images))
      input.accepted()
      for await (const message of transport.read()) {
        if (message.type === 'system' && message.subtype === 'init') {
          started = true
          if (isNonBlankString(message.session_id)) input.sessionStarted(message.session_id)
          continue
        }
        if (message.type === 'result') {
          result = message
          if (isNonBlankString(message.session_id)) input.sessionStarted(message.session_id)
          // 一轮一个进程：这一回合收尾就不再有输入，命令行随即退出。
          transport.endInput()
          continue
        }
        translator.apply(message)
      }
      const exit = await transport.exited
      if (signal.aborted) return { status: 'aborted' }
      if (!result) {
        if (resume && !started) throw new ClaudeCodeResumeLost()
        throw new AppError(
          'UNAVAILABLE',
          exit.stderr
            ? workbenchMainText('engines.claudeRunIncompleteWithReason', { reason: exit.stderr })
            : workbenchMainText('engines.claudeRunIncomplete')
        )
      }
      if (
        result.is_error === true ||
        (isString(result.subtype) && result.subtype.startsWith('error'))
      )
        throw new AppError('UNAVAILABLE', resultError(result))
      return { status: 'completed' }
    } catch (error) {
      if (signal.aborted) return { status: 'aborted' }
      if (error instanceof ClaudeCodeResumeLost) throw error
      if (resume && !started) throw new ClaudeCodeResumeLost()
      throw error
    } finally {
      signal.removeEventListener('abort', stop)
      transport.close()
      this.running.delete(transport)
    }
  }

  /** 命令行问的工具权限（`can_use_tool`）：提问与计划审批画成提问卡，其余按 Workbench 的权限档回答。 */
  private async permission(
    input: WorkbenchEngineRunInput,
    control: ClaudeCodeControlRequest
  ): Promise<Record<string, unknown>> {
    if (control.subtype !== 'can_use_tool')
      throw new AppError(
        'PROTOCOL',
        workbenchMainText('engines.unhandledRequest', { request: String(control.subtype) })
      )
    const toolName = isString(control.request.tool_name) ? control.request.tool_name : ''
    const toolInput = isPlainObject(control.request.input) ? control.request.input : {}
    const toolUseID = isString(control.request.tool_use_id)
      ? control.request.tool_use_id
      : undefined
    const signal = AbortSignal.any([control.signal, input.signal])
    const allow = (updatedInput: Record<string, unknown>): Record<string, unknown> => ({
      behavior: 'allow',
      updatedInput,
      toolUseID,
    })
    const deny = (message: string): Record<string, unknown> => ({
      behavior: 'deny',
      message,
      toolUseID,
    })
    const zh = input.locale !== 'en-US'
    try {
      if (toolName === 'AskUserQuestion') {
        const answers = await askQuestions(input.surface, toolInput, signal)
        return answers
          ? allow({ ...toolInput, answers })
          : deny(zh ? '用户跳过了这个问题。' : 'The user skipped the question.')
      }
      if (toolName === 'ExitPlanMode') {
        const plan = isNonBlankString(toolInput.plan) ? toolInput.plan : ''
        const start = zh ? '开始执行' : 'Start'
        const answer = await input.surface.ask(
          {
            question: [zh ? '按这个计划开始做吗？' : 'Start working on this plan?', plan]
              .filter(Boolean)
              .join('\n\n'),
            options: [{ label: start }, { label: zh ? '先不执行' : 'Not yet' }],
            allowText: true,
          },
          signal
        )
        if (!answer.declined && answer.choices.includes(start)) return allow(toolInput)
        return deny(
          answer.text ??
            (zh ? '用户想先调整计划，暂不执行。' : 'The user wants to revise the plan first.')
        )
      }
      const confirmation = engineConfirmation(
        input.permissionMode,
        claudeAction(toolName, toolInput, input.ref.projectRoot),
        input.ref.projectRoot,
        input.locale
      )
      if (!confirmation) return allow(toolInput)
      const decision = await input.surface.confirm(confirmation, signal)
      return decision.approved
        ? allow(toolInput)
        : deny(decision.reason ?? (zh ? '用户拒绝了这次操作。' : 'The user declined this action.'))
    } catch (error) {
      if (signal.aborted) return deny(zh ? '运行已停止。' : 'The run was stopped.')
      throw error
    }
  }
}

/**
 * 把命令行的消息流画进对话：逐字的正文与思考（stream_event）、工具调用的开始与参数、工具结果。子任务
 * （parent_tool_use_id 不空）内部的消息不画，子任务那一步的工具卡在它结束时带上结果。
 */
class ClaudeCodeTranslator {
  private messageId = ''
  private readonly blocks = new Map<number, StreamBlock>()
  /** 经 stream_event 逐字到过的回复：完整回复到达时不再重复画它的正文。 */
  private readonly streamed = new Set<string>()
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>()
  private sequence = 0

  public constructor(
    private readonly surface: EngineRunSurface,
    private readonly projectRoot: string,
    private readonly locale: AppLocale
  ) {}

  public apply(message: ClaudeCodeMessage): void {
    if (isNonBlankString(message.parent_tool_use_id)) return
    switch (message.type) {
      case 'system':
        if (message.subtype === 'api_retry') this.retry(message)
        return
      case 'stream_event':
        if (isPlainObject(message.event)) this.stream(message.event)
        return
      case 'assistant':
        if (isPlainObject(message.message)) this.assistant(message.message)
        return
      case 'user':
        if (isPlainObject(message.message)) this.toolResults(message.message)
        return
    }
  }

  private stream(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'message_start': {
        const message = isPlainObject(event.message) ? event.message : {}
        this.messageId = isNonBlankString(message.id) ? message.id : `message-${++this.sequence}`
        this.streamed.add(this.messageId)
        this.blocks.clear()
        this.surface.phase('researching')
        return
      }
      case 'content_block_start': {
        const index = Number(event.index)
        const block = isPlainObject(event.content_block) ? event.content_block : {}
        const segment = `${this.messageId}:${index}`
        if (block.type === 'text') {
          this.blocks.set(index, { kind: 'text', segment })
          if (isNonBlankString(block.text)) this.surface.appendText(segment, block.text)
        } else if (block.type === 'thinking') {
          this.blocks.set(index, { kind: 'thinking', segment })
          if (isNonBlankString(block.thinking)) this.surface.appendThinking(segment, block.thinking)
        } else if (
          (block.type === 'tool_use' || block.type === 'server_tool_use') &&
          isNonBlankString(block.id) &&
          isNonBlankString(block.name)
        ) {
          this.blocks.set(index, {
            kind: 'tool',
            segment,
            id: block.id,
            name: block.name,
            json: '',
          })
          this.startTool(block.id, block.name, {})
        }
        return
      }
      case 'content_block_delta': {
        const block = this.blocks.get(Number(event.index))
        const delta = isPlainObject(event.delta) ? event.delta : {}
        if (!block) return
        if (block.kind === 'text' && delta.type === 'text_delta' && isString(delta.text))
          this.surface.appendText(block.segment, delta.text)
        else if (
          block.kind === 'thinking' &&
          delta.type === 'thinking_delta' &&
          isString(delta.thinking)
        )
          this.surface.appendThinking(block.segment, delta.thinking)
        else if (
          block.kind === 'tool' &&
          delta.type === 'input_json_delta' &&
          isString(delta.partial_json)
        )
          block.json += delta.partial_json
        return
      }
      case 'content_block_stop': {
        const block = this.blocks.get(Number(event.index))
        if (!block) return
        if (block.kind === 'text') this.surface.finishText(block.segment)
        if (block.kind === 'tool') this.toolInput(block.id, block.name, parseJsonObject(block.json))
        return
      }
    }
  }

  /** 完整的一条回复：逐字到过的只补工具参数；没逐字到过的（命令行自己合成的回复）整段画上。 */
  private assistant(message: Record<string, unknown>): void {
    const id = isNonBlankString(message.id) ? message.id : `message-${++this.sequence}`
    const content = isArray(message.content) ? message.content.filter(isPlainObject) : []
    const streamed = this.streamed.has(id)
    // 命令行合成的回复（登录失败、接口出错）与这一轮的错误说明是同一句话，错误里已经有了。
    const synthetic = message.model === '<synthetic>'
    content.forEach((block, index) => {
      if (block.type === 'tool_use' && isNonBlankString(block.id) && isNonBlankString(block.name)) {
        this.toolInput(block.id, block.name, isPlainObject(block.input) ? block.input : {})
        return
      }
      if (streamed || synthetic) return
      const segment = `${id}:full:${index}`
      if (block.type === 'text' && isString(block.text))
        this.surface.finishText(segment, block.text)
      if (block.type === 'thinking' && isString(block.thinking))
        this.surface.appendThinking(segment, block.thinking)
    })
  }

  private toolResults(message: Record<string, unknown>): void {
    const content = isArray(message.content) ? message.content.filter(isPlainObject) : []
    for (const block of content) {
      if (block.type !== 'tool_result' || !isNonBlankString(block.tool_use_id)) continue
      const id = block.tool_use_id
      const text = toolResultText(block.content)
      const tool = this.tools.get(id)
      if (tool?.name === 'TodoWrite' && block.is_error !== true)
        this.surface.finishTool(id, { result: { plan: todoPlan(tool.input) } })
      else
        this.surface.finishTool(
          id,
          block.is_error === true ? { error: text || workbenchMainText('engines.toolCallFailed') } : { result: text }
        )
      const edited =
        tool && EditTools.has(tool.name) && block.is_error !== true
          ? projectRelativePaths(this.projectRoot, editPaths(tool.input))
          : []
      this.surface.endProjectActivity(id, edited)
    }
  }

  /** 接口出错、命令行在重试：状态行说一句。 */
  private retry(message: ClaudeCodeMessage): void {
    const zh = this.locale !== 'en-US'
    const attempt = isFiniteNumber(message.attempt) ? message.attempt : undefined
    const total = isFiniteNumber(message.max_retries) ? message.max_retries : undefined
    const count = attempt ? (total ? `${attempt}/${total}` : String(attempt)) : ''
    this.surface.reconnecting(
      zh
        ? `Claude Code 正在重试${count ? `（${count}）` : ''}…`
        : `Claude Code is retrying${count ? ` (${count})` : ''}…`
    )
  }

  private startTool(id: string, name: string, input: Record<string, unknown>): void {
    this.surface.startTool({ id, ...presentClaudeTool(name, input, this.projectRoot, this.locale) })
    this.surface.phase('executing')
  }

  /** 参数写完了：补到工具卡上；会改项目的工具从这里开始算 Agent 动手的时间窗。 */
  private toolInput(id: string, name: string, input: Record<string, unknown>): void {
    const known = this.tools.get(id)
    if (known && Object.keys(known.input).length > 0 && Object.keys(input).length === 0) return
    this.tools.set(id, { name, input })
    if (!this.surface.isToolRunning(id)) {
      if (known) return
      this.startTool(id, name, input)
    } else
      this.surface.updateTool(id, presentClaudeTool(name, input, this.projectRoot, this.locale))
    if (name === 'Bash' || EditTools.has(name)) this.surface.beginProjectActivity(id)
  }
}

type StreamBlock =
  | { kind: 'text' | 'thinking'; segment: string }
  | { kind: 'tool'; segment: string; id: string; name: string; json: string }

/** 工具卡：界面认得的工具名（决定图标）加一句这次做什么。 */
function presentClaudeTool(
  name: string,
  input: Record<string, unknown>,
  projectRoot: string,
  locale: AppLocale
): { toolName: string; title: string; args: Record<string, unknown> } {
  const zh = locale !== 'en-US'
  const text = (key: string): string =>
    isString(input[key]) ? oneLine(input[key], TitleChars) : ''
  const path = (key: string): string =>
    isNonBlankString(input[key]) ? oneLine(displayPath(projectRoot, input[key]), TitleChars) : ''
  switch (name) {
    case 'Bash':
      return {
        toolName: 'project:run',
        title: text('description') || text('command') || name,
        args: input,
      }
    case 'Write':
      return {
        toolName: 'project:edit',
        title: `${zh ? '写入' : 'Write'} ${path('file_path')}`.trim(),
        args: input,
      }
    case 'Edit':
    case 'MultiEdit':
      return {
        toolName: 'project:edit',
        title: `${zh ? '编辑' : 'Edit'} ${path('file_path')}`.trim(),
        args: input,
      }
    case 'NotebookEdit':
      return {
        toolName: 'project:edit',
        title: `${zh ? '编辑' : 'Edit'} ${path('notebook_path')}`.trim(),
        args: input,
      }
    case 'Read':
      return {
        toolName: 'project:read',
        title: `${zh ? '读取' : 'Read'} ${path('file_path')}`.trim(),
        args: input,
      }
    case 'Glob':
      return {
        toolName: 'project:list',
        title: `${zh ? '查找文件' : 'Find files'} ${text('pattern')}`.trim(),
        args: input,
      }
    case 'Grep':
      return {
        toolName: 'project:search',
        title: `${zh ? '搜索' : 'Search'} ${text('pattern')}`.trim(),
        args: input,
      }
    case 'WebSearch':
    case 'web_search':
      return {
        toolName: 'web:search',
        title: `${zh ? '搜索网页' : 'Search the web'} ${text('query')}`.trim(),
        args: input,
      }
    case 'WebFetch':
    case 'web_fetch':
      return {
        toolName: 'web:read',
        title: `${zh ? '读取网页' : 'Read page'} ${text('url')}`.trim(),
        args: input,
      }
    case 'Task':
    case 'Agent':
      return {
        toolName: 'agent:dispatch',
        title: text('description') || (zh ? '派出子任务' : 'Run a subtask'),
        args: input,
      }
    case 'TodoWrite':
      return {
        toolName: 'plan:update',
        title: zh ? '更新计划' : 'Update plan',
        args: { plan: todoPlan(input) },
      }
    default:
      return { toolName: name, title: name, args: input }
  }
}

/** 工具权限请求里要问用户的那件事。 */
function claudeAction(
  name: string,
  input: Record<string, unknown>,
  projectRoot: string
): EngineAction {
  if (name === 'Bash' && isNonBlankString(input.command))
    return {
      kind: 'command',
      command: input.command,
      cwd: projectRoot,
      reason: isNonBlankString(input.description) ? input.description : undefined,
    }
  if (EditTools.has(name)) return { kind: 'edit', paths: editPaths(input) }
  const detail = ['url', 'query', 'file_path', 'path', 'pattern', 'command', 'description']
    .map((key) => input[key])
    .find(isNonBlankString)
  return { kind: 'other', name, detail }
}

function editPaths(input: Record<string, unknown>): string[] {
  return [input.file_path, input.notebook_path].filter(isNonBlankString)
}

/** TodoWrite 的待办换成计划卡认的步骤。 */
function todoPlan(input: Record<string, unknown>): Array<{ step: string; status: string }> {
  const todos = isArray(input.todos) ? input.todos.filter(isPlainObject) : []
  return todos.flatMap((todo) => {
    const step = [todo.content, todo.activeForm].find(isNonBlankString)
    return step ? [{ step, status: isString(todo.status) ? todo.status : 'pending' }] : []
  })
}

/**
 * AskUserQuestion：一题一张提问卡，依次问；回答按命令行认的形状写回参数（题目 → 选中的选项，多个用逗号连）。
 * 用户跳过任何一题时返回 null。
 */
async function askQuestions(
  surface: EngineRunSurface,
  input: Record<string, unknown>,
  signal: AbortSignal
): Promise<Nullable<Record<string, string>>> {
  const questions = isArray(input.questions) ? input.questions.filter(isPlainObject) : []
  const answers: Record<string, string> = {}
  for (const question of questions) {
    if (!isNonBlankString(question.question)) continue
    const options = (
      isArray(question.options) ? question.options.filter(isPlainObject) : []
    ).flatMap((option) =>
      isNonBlankString(option.label)
        ? [{ label: option.label, description: optionalWhen(isNonBlankString, option.description) }]
        : []
    )
    const header = isNonBlankString(question.header) ? `${question.header}\n` : ''
    const answer = await surface.ask(
      {
        question: `${header}${question.question}`,
        options,
        multiple: question.multiSelect === true,
        allowText: true,
      },
      signal
    )
    if (answer.declined) return null
    const value = [...answer.choices, ...(answer.text ? [answer.text] : [])].join(', ')
    if (!value) return null
    answers[question.question] = value
  }
  return answers
}

/** 发给命令行的一条用户消息：文字加图片。 */
function userContent(text: string, images: readonly WorkbenchConversationImage[]): unknown[] {
  return [
    ...(text ? [{ type: 'text', text }] : []),
    ...images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    })),
  ]
}

/** 模型目录：同一个实际模型的几个别名合成一项（「默认」与它指向的那个模型是同一个）。 */
function readClaudeModels(value: unknown): {
  models: WorkbenchAgentEngineModel[]
  effort: string[]
} {
  const entries = (isArray(value) ? value.filter(isPlainObject) : []).filter((entry) =>
    isNonBlankString(entry.value)
  )
  const recommended = entries[0] ? wireModel(entries[0]) : null
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const entry of entries)
    groups.set(wireModel(entry), [...(groups.get(wireModel(entry)) ?? []), entry])
  const models: WorkbenchAgentEngineModel[] = []
  const effort: string[] = []
  for (const [wire, group] of groups) {
    const chosen = group.find((entry) => entry.value === wire) ?? group.at(-1)!
    const value = String(chosen.value)
    models.push({
      value,
      label: isNonBlankString(chosen.displayName) ? chosen.displayName : value,
      description: optionalWhen(isNonBlankString, chosen.description),
      isDefault: optionalWhen(wire === recommended, true),
    })
    if (chosen.supportsEffort === true) effort.push(value)
  }
  return { models, effort }
}

function wireModel(entry: Record<string, unknown>): string {
  return isNonBlankString(entry.resolvedModel) ? entry.resolvedModel.trim() : String(entry.value)
}

/** 查登录：`claude auth status` 报 JSON；查不出来（旧版本没有这条命令）时不下结论。 */
async function readLoginState(
  command: WorkbenchEngineCommand,
  signal?: AbortSignal
): Promise<boolean | undefined> {
  try {
    const { stdout } = await runEngineCommand(command, ['auth', 'status'], {
      cwd: homedir(),
      timeoutMs: StatusTimeoutMs,
      signal,
    })
    const status: unknown = JSON.parse(stdout)
    return isPlainObject(status) && typeof status.loggedIn === 'boolean'
      ? status.loggedIn
      : undefined
  } catch (error) {
    signal?.throwIfAborted()
    log.debug('查不出 Claude Code 的登录状态', { error: AppError.getMessage(error) })
    return undefined
  }
}

function resultError(result: ClaudeCodeMessage): string {
  if (isNonBlankString(result.result)) return result.result
  const errors = isArray(result.errors) ? result.errors.filter(isNonBlankString) : []
  return errors.join('\n') || workbenchMainText('engines.claudeRunIncomplete')
}

/** 工具结果的文字：字符串原样，内容块取文字、图片记一句。 */
function toolResultText(content: unknown): string {
  if (isString(content)) return content
  if (!isArray(content)) return ''
  return content
    .filter(isPlainObject)
    .map((block) =>
      block.type === 'text' && isString(block.text)
        ? block.text
        : block.type === 'image'
          ? '[image]'
          : ''
    )
    .filter(Boolean)
    .join('\n')
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    const value: unknown = JSON.parse(text)
    return isPlainObject(value) ? value : {}
  } catch {
    return {}
  }
}
