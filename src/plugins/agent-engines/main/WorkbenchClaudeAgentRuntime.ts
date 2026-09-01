import type { ModelMessage } from 'ai'

import {
  type ExecutionEventBus,
} from '@velaros-ai/agent'

import type { WorkbenchAgentEngineModelCatalog } from '../../../shared/workbenchResourcePlugins'

import type {
  ClaudeAgentModelInfo,
  ClaudeAgentPermissionResult,
  ClaudeAgentQuery,
  ClaudeAgentSdkMessage,
} from './ClaudeAgentPluginContract'
import { getWorkbenchAgentEngineEnvironment } from './WorkbenchAgentEngineProcess'
import type { WorkbenchAgentEngineSessionStore } from './WorkbenchAgentEngineSessionStore'
import {
  ProjectCodeSearchToolName,
  ProjectCodeToolIdentity,
  type WorkbenchAgentExtensionTools,
} from './WorkbenchAgentExtensionTools'
import type { WorkbenchAgentPluginResolver } from './WorkbenchAgentPluginResolver'
import {
  type WorkbenchAgentEngineQuestion,
  type WorkbenchEngineInteractionBroker,
} from './WorkbenchEngineInteractionBroker'

interface WorkbenchClaudeRunInput {
  executionId: string
  sessionId: string
  projectRoot: string
  messages: ModelMessage[]
  executionModes: readonly string[]
  model?: string
  events: ExecutionEventBus
  abortSignal: AbortSignal
}

/** Claude Code 官方 Agent SDK 适配器；登录态、原生工具与会话账本都仍归 Claude。 */
export class WorkbenchClaudeAgentRuntime {
  private readonly nativeSessions = new Map<string, string>()
  private readonly activeQueries = new Map<string, ClaudeAgentQuery>()

  public constructor(
    private readonly interactions: WorkbenchEngineInteractionBroker,
    private readonly sessions: WorkbenchAgentEngineSessionStore,
    private readonly extensionTools: WorkbenchAgentExtensionTools,
    private readonly pluginResolver: WorkbenchAgentPluginResolver
  ) {}

  public async run(input: WorkbenchClaudeRunInput): Promise<{ status: 'completed' | 'aborted' }> {
    const abortController = new AbortController()
    const abort = (): void => abortController.abort(input.abortSignal.reason)
    input.abortSignal.addEventListener('abort', abort, { once: true })
    const nativeSessionId = this.nativeSessions.get(input.sessionId)
      ?? await this.sessions.get('claude-code', input.sessionId, input.projectRoot)
    let emittedText = false
    let resultError: string | null = null
    let active: ClaudeAgentQuery | null = null

    try {
      const environment = await getWorkbenchAgentEngineEnvironment()
      const sdk = await this.pluginResolver.loadClaudeSdk()
      active = sdk.query({
        prompt: buildClaudePrompt(input.messages, input.executionModes, !!nativeSessionId),
        options: {
          abortController,
          additionalDirectories: [input.projectRoot],
          canUseTool: (toolName, toolInput, options) => this.resolveToolPermission(
            input,
            toolName,
            toolInput,
            options.signal
          ),
          cwd: input.projectRoot,
          env: environment,
          includePartialMessages: true,
          mcpServers: {
            'velaros-workbench': this.extensionTools.claudeServer(input.projectRoot, sdk),
          },
          pathToClaudeCodeExecutable: 'claude',
          model: input.model,
          permissionMode: 'default',
          resume: nativeSessionId ?? undefined,
          settingSources: ['user', 'project', 'local'],
        },
      })
      this.activeQueries.set(input.sessionId, active)

      for await (const message of active) {
        const sessionId = readMessageSessionId(message)
        if (sessionId && sessionId !== this.nativeSessions.get(input.sessionId)) {
          this.nativeSessions.set(input.sessionId, sessionId)
          await this.sessions.set('claude-code', input.sessionId, input.projectRoot, sessionId)
        }
        const translated = translateClaudeMessage(message)
        for (const text of translated.text) {
          emittedText = true
          input.events.emitTextDelta(text)
        }
        for (const text of translated.reasoning) {
          input.events.emitReasoningDelta({ id: 'claude-reasoning', text })
        }
        if (translated.toolStart) {
          input.events.emitToolStart({
            toolCallId: translated.toolStart.id,
            toolName: translated.toolStart.name,
            args: translated.toolStart.input,
          })
        }
        if (translated.toolDone) {
          input.events.emitToolDone({
            toolCallId: translated.toolDone.id,
            result: translated.toolDone.result,
            ...(translated.toolDone.error ? { error: translated.toolDone.error } : {}),
          })
        }
        if (translated.error) resultError = translated.error
      }

      if (input.abortSignal.aborted || abortController.signal.aborted) return { status: 'aborted' }
      if (resultError) throw new Error(resultError)
      if (!emittedText) input.events.emitTextDelta('Claude 已完成本次任务。')
      return { status: 'completed' }
    } catch (error) {
      if (
        nativeSessionId
        && !emittedText
        && !input.abortSignal.aborted
        && !abortController.signal.aborted
      ) {
        this.nativeSessions.delete(input.sessionId)
        await this.sessions.delete('claude-code', input.sessionId)
        return await this.run(input)
      }
      throw error
    } finally {
      input.abortSignal.removeEventListener('abort', abort)
      this.activeQueries.delete(input.sessionId)
      active?.close()
    }
  }

  public close(): void {
    for (const active of this.activeQueries.values()) active.close()
    this.activeQueries.clear()
    this.nativeSessions.clear()
  }

  public async listModels(): Promise<WorkbenchAgentEngineModelCatalog> {
    let probe: ClaudeAgentQuery | null = null
    try {
      const sdk = await this.pluginResolver.loadClaudeSdk()
      probe = sdk.query({
        prompt: '',
        options: {
          env: await getWorkbenchAgentEngineEnvironment(),
          pathToClaudeCodeExecutable: 'claude',
          permissionMode: 'plan',
          settingSources: ['user'],
        },
      })
      const models = normalizeClaudeModels(await probe.supportedModels())
      return {
        engineId: 'claude-code',
        available: models.length > 0,
        ...(models.length > 0 ? {} : { reason: 'Claude Code 未上报可用模型，请检查安装与登录状态。' }),
        models,
      }
    } catch (error) {
      return {
        engineId: 'claude-code',
        available: false,
        reason: readableError(error, '无法连接 Claude Code，请检查安装与登录状态。'),
        models: [],
      }
    } finally {
      probe?.close()
    }
  }

  private async resolveToolPermission(
    input: WorkbenchClaudeRunInput,
    toolName: string,
    toolInput: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ClaudeAgentPermissionResult> {
    if (this.extensionTools.isBundledReadOnlyTool(toolName)) return { behavior: 'allow' }
    if (toolName === 'AskUserQuestion') {
      const questions = normalizeClaudeQuestions(toolInput)
      const answers = await this.interactions.requestInput({
        sessionId: input.sessionId,
        executionId: input.executionId,
        questions,
        events: input.events,
        signal,
      })
      return {
        behavior: 'allow',
        updatedInput: {
          ...toolInput,
          answers: Object.fromEntries(questions.map((question) => [
            question.question,
            (answers[question.id] ?? []).join(', '),
          ])),
        },
      }
    }

    const decision = await this.interactions.requestConfirmation({
      sessionId: input.sessionId,
      executionId: input.executionId,
      message: buildClaudePermissionMessage(toolName, toolInput),
      categoryId: claudePermissionCategory(toolName),
      categoryLabel: claudePermissionCategoryLabel(toolName),
      toolName,
      events: input.events,
      signal,
    })
    return decision.approved
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: decision.message ?? '用户拒绝了这次工具调用。' }
  }
}

interface TranslatedClaudeMessage {
  text: string[]
  reasoning: string[]
  error: string | null
  toolStart?: { id: string; name: string; input: Record<string, unknown> }
  toolDone?: { id: string; result: unknown; error?: string }
}

function translateClaudeMessage(message: ClaudeAgentSdkMessage): TranslatedClaudeMessage {
  if (message.type === 'stream_event') {
    const event = asRecord(message.event)
    const delta = asRecord(event.delta)
    if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
      const text = readString(delta.text)
      return { text: text ? [text] : [], reasoning: [], error: null }
    }
    if (event.type === 'content_block_delta' && delta.type === 'thinking_delta') {
      const thinking = readString(delta.thinking)
      return { text: [], reasoning: thinking ? [thinking] : [], error: null }
    }
    const contentBlock = asRecord(event.content_block)
    if (event.type === 'content_block_start' && contentBlock.type === 'tool_use') {
      const name = readString(contentBlock.name)
      const id = readString(contentBlock.id)
      if (!name || !id) return { text: [], reasoning: [], error: null }
      const presented = presentClaudeTool(
        name,
        asRecord(contentBlock.input)
      )
      return {
        text: [],
        reasoning: [],
        error: null,
        toolStart: {
          id,
          name: presented.name,
          input: presented.input,
        },
      }
    }
  }
  if (message.type === 'user') {
    const envelope = asRecord(message.message)
    const blocks = Array.isArray(envelope.content) ? envelope.content : []
    const result = blocks.map(asRecord).find((block) => block.type === 'tool_result')
    const id = readString(result?.tool_use_id)
    if (result && id) {
      const error = result.is_error === true ? stringifyValue(result.content) : undefined
      return {
        text: [],
        reasoning: [],
        error: null,
        toolDone: { id, result: result.content, ...(error ? { error } : {}) },
      }
    }
  }
  if (message.type === 'result' && message.is_error === true) {
    const errors = Array.isArray(message.errors)
      ? message.errors.filter((item): item is string => typeof item === 'string')
      : []
    return { text: [], reasoning: [], error: errors.join('\n') || 'Claude 运行失败。' }
  }
  return { text: [], reasoning: [], error: null }
}

function normalizeClaudeQuestions(input: Record<string, unknown>): WorkbenchAgentEngineQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const questions = rawQuestions.map(asRecord).flatMap((question, index) => {
    const text = readString(question.question)
    if (!text) return []
    const options = (Array.isArray(question.options) ? question.options : [])
      .map(asRecord)
      .flatMap((option) => {
        const label = readString(option.label)
        return label ? [{ label, description: readString(option.description) ?? undefined }] : []
      })
    return [{
      id: `q${index}`,
      header: readString(question.header) ?? `问题 ${index + 1}`,
      question: text,
      options,
      multiple: question.multiSelect === true,
    }]
  })
  return questions.length > 0
    ? questions
    : [{ id: 'q0', header: '问题', question: 'Claude 需要你的补充信息。', options: [] }]
}

function presentClaudeTool(
  name: string,
  input: Record<string, unknown>
): { name: string; input: Record<string, unknown> } {
  if (name === ProjectCodeSearchToolName || name.endsWith(`__${ProjectCodeSearchToolName}`)) return { name: ProjectCodeToolIdentity, input }
  if (name === 'Bash') return { name: 'project:run', input }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const path = input.file_path ?? input.notebook_path
    return { name: 'project:edit', input: { ...input, ...(path ? { path } : {}) } }
  }
  if (name === 'Read') return { name: 'project:read', input }
  if (name === 'Glob') return { name: 'project:list', input }
  if (name === 'Grep') return { name: 'project:search', input }
  if (name === 'WebSearch') return { name: 'web:search', input }
  if (name === 'WebFetch') return { name: 'web:read', input }
  if (name === 'Agent' || name === 'Task') return { name: 'agent:dispatch', input }
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos.map(asRecord) : []
    return {
      name: 'plan:update',
      input: {
        plan: todos.map((todo) => ({
          step: readString(todo.content) ?? readString(todo.activeForm) ?? 'Task',
          status: todo.status,
        })),
      },
    }
  }
  return { name, input }
}

function buildClaudePrompt(
  messages: readonly ModelMessage[],
  executionModes: readonly string[],
  resumed: boolean
): string {
  const source = resumed ? messages.slice(-1) : messages
  return `${buildModeInstructions(executionModes)}\n\n${formatMessages(source)}`
}

function formatMessages(messages: readonly ModelMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content)
    return `${message.role.toUpperCase()}:\n${content}`
  }).join('\n\n')
}

function buildModeInstructions(executionModes: readonly string[]): string {
  return [
    'Work directly in the current project. Keep changes focused and report the result concisely.',
    ...(executionModes.includes('goal')
      ? ['VelarOS goal mode is active: keep advancing the latest objective until it is genuinely achieved.']
      : []),
    ...(executionModes.includes('plan')
      ? ['VelarOS plan mode is active: maintain and update a concise plan while continuing implementation. Plan mode is writable.']
      : []),
  ].join('\n')
}

function readMessageSessionId(message: ClaudeAgentSdkMessage): string | null {
  return readString(message.session_id)
}

function normalizeClaudeModels(
  models: readonly ClaudeAgentModelInfo[]
): WorkbenchAgentEngineModelCatalog['models'] {
  const groups = new Map<string, ClaudeAgentModelInfo[]>()
  for (const model of models) {
    const wireId = model.resolvedModel?.trim() || model.value
    groups.set(wireId, [...(groups.get(wireId) ?? []), model])
  }
  const recommended = models[0]
    ? models[0].resolvedModel?.trim() || models[0].value
    : null
  return [...groups.entries()].map(([wireId, group]) => {
    const model = group.find((candidate) => candidate.value === wireId) ?? group.at(-1)!
    return {
      value: model.value,
      label: model.displayName,
      ...(model.description?.trim() ? { description: model.description } : {}),
      isDefault: wireId === recommended,
    }
  })
}

function buildClaudePermissionMessage(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const detail = readString(toolInput.command)
    ?? readString(toolInput.file_path)
    ?? readString(toolInput.path)
  return detail
    ? `Claude 请求使用 ${toolName}：${detail}`
    : `Claude 请求使用 ${toolName}。`
}

function claudePermissionCategory(toolName: string): string {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return 'file-change'
  if (toolName === 'Bash') return 'command'
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'external-tool'
}

function claudePermissionCategoryLabel(toolName: string): string {
  const category = claudePermissionCategory(toolName)
  if (category === 'file-change') return '文件变更'
  if (category === 'command') return '命令执行'
  if (category === 'mcp') return '插件工具'
  return '外部工具'
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
