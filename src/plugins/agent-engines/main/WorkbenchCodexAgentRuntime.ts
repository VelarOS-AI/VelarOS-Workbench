import type { ModelMessage } from 'ai'

import type { ExecutionEventBus } from '@velaros-ai/agent'
import { optionalWhen, toOptional } from '@velaros-ai/core'

import type { WorkbenchAgentEngineModelCatalog } from '../../../shared/workbenchResourcePlugins'

import type { WorkbenchAgentEngineSessionStore } from './WorkbenchAgentEngineSessionStore'
import {
  ProjectCodeSearchToolName,
  ProjectCodeToolIdentity,
  type WorkbenchAgentExtensionTools,
} from './WorkbenchAgentExtensionTools'
import type { WorkbenchAgentPluginResolver } from './WorkbenchAgentPluginResolver'
import {
  WorkbenchCodexAppServerClient,
  type WorkbenchCodexRpcEnvelope,
  type WorkbenchCodexRpcId,
} from './WorkbenchCodexAppServerClient'
import {
  type WorkbenchAgentEngineQuestion,
  type WorkbenchEngineInteractionBroker,
} from './WorkbenchEngineInteractionBroker'

interface WorkbenchCodexRunInput {
  executionId: string
  sessionId: string
  projectRoot: string
  messages: ModelMessage[]
  executionModes: readonly string[]
  model?: string
  events: ExecutionEventBus
  abortSignal: AbortSignal
}

interface ActiveCodexRun {
  input: WorkbenchCodexRunInput
  threadId: string
  turnId: string | null
  resolve: (status: 'completed' | 'aborted') => void
  reject: (error: Error) => void
}

/** Codex app-server 适配器；复用 Codex 的原生工具、登录态、目标与 request_user_input。 */
export class WorkbenchCodexAgentRuntime {
  private client: WorkbenchCodexAppServerClient | null = null
  private removeClientListener: (() => void) | null = null
  private readonly nativeThreads = new Map<string, string>()
  private readonly activeByThread = new Map<string, ActiveCodexRun>()

  public constructor(
    private readonly interactions: WorkbenchEngineInteractionBroker,
    private readonly sessions: WorkbenchAgentEngineSessionStore,
    private readonly extensionTools: WorkbenchAgentExtensionTools,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly productVersion: string,
    private readonly pluginResolver: WorkbenchAgentPluginResolver
  ) {}

  public async run(input: WorkbenchCodexRunInput): Promise<{ status: 'completed' | 'aborted' }> {
    const client = await this.ensureClient()
    let existingThreadId = this.nativeThreads.get(input.sessionId)
      ?? await this.sessions.get('codex', input.sessionId, input.projectRoot)
    let threadId: string | null = null
    if (existingThreadId) {
      try {
        threadId = readThreadId(await client.request('thread/resume', {
            threadId: existingThreadId,
            cwd: input.projectRoot,
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: 'workspace-write',
            model: input.model,
          })) ?? existingThreadId
      } catch {
        this.nativeThreads.delete(input.sessionId)
        await this.sessions.delete('codex', input.sessionId)
        existingThreadId = null
      }
    }
    threadId ??= readThreadId(await client.request('thread/start', {
          cwd: input.projectRoot,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'workspace-write',
          model: input.model,
          ephemeral: false,
          developerInstructions: buildModeInstructions(input.executionModes),
          dynamicTools: this.extensionTools.codexSpecs(),
        }))
    if (!threadId) throw new Error('Codex 未返回 thread id。')
    this.nativeThreads.set(input.sessionId, threadId)
    await this.sessions.set('codex', input.sessionId, input.projectRoot, threadId)
    await this.applyGoal(client, threadId, input)

    let settle: ActiveCodexRun | null = null
    const terminal = new Promise<'completed' | 'aborted'>((resolve, reject) => {
      settle = { input, threadId, turnId: null, resolve, reject }
      this.activeByThread.set(threadId, settle)
    })
    const abort = (): void => {
      const active = this.activeByThread.get(threadId)
      if (!active) return
      this.interactions.cancelSession(input.sessionId, '用户已停止本次执行。')
      if (active.turnId) {
        void client.request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => undefined)
      }
      this.activeByThread.delete(threadId)
      active.resolve('aborted')
    }
    input.abortSignal.addEventListener('abort', abort, { once: true })

    try {
      const turn = asRecord(await client.request('turn/start', {
        threadId,
        input: [{
          type: 'text',
          text: buildCodexPrompt(
            input.messages,
            input.executionModes,
            !!existingThreadId
          ),
          text_elements: [],
        }],
        cwd: input.projectRoot,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [input.projectRoot],
        },
        model: input.model,
      }))
      const turnId = readString(asRecord(turn.turn).id)
      const active = this.activeByThread.get(threadId)
      if (active) active.turnId = turnId
      return { status: await terminal }
    } catch (error) {
      this.activeByThread.delete(threadId)
      throw error
    } finally {
      input.abortSignal.removeEventListener('abort', abort)
      this.activeByThread.delete(threadId)
    }
  }

  public close(): void {
    this.removeClientListener?.()
    this.removeClientListener = null
    this.client?.close()
    this.client = null
    this.nativeThreads.clear()
    for (const active of this.activeByThread.values()) {
      active.reject(new Error('Codex app-server 已关闭。'))
    }
    this.activeByThread.clear()
  }

  public async listModels(): Promise<WorkbenchAgentEngineModelCatalog> {
    try {
      const response = asRecord(await (await this.ensureClient()).request('model/list', {
        includeHidden: false,
      }))
      const models = (Array.isArray(response.data) ? response.data : [])
        .map(asRecord)
        .flatMap((model) => {
          const value = readString(model.id)
          if (!value) return []
          const description = readString(model.description)
          return [{
            value,
            label: readString(model.displayName) ?? value,
            description: toOptional(description),
            isDefault: model.isDefault === true,
          }]
        })
      return {
        engineId: 'codex',
        available: models.length > 0,
        reason: optionalWhen(models.length === 0, 'Codex 未上报可用模型，请检查安装与登录状态。'),
        models,
      }
    } catch (error) {
      return {
        engineId: 'codex',
        available: false,
        reason: error instanceof Error && error.message.trim()
          ? error.message
          : '无法连接 Codex，请检查安装与登录状态。',
        models: [],
      }
    }
  }

  private async ensureClient(): Promise<WorkbenchCodexAppServerClient> {
    if (this.client) return this.client
    const command = this.pluginResolver.resolveCodexCommand()
    if (!command) throw new Error('Codex Agent 插件运行时不完整，请重新安装。')
    const client = await WorkbenchCodexAppServerClient.create(command, this.productVersion)
    this.client = client
    this.removeClientListener = client.onEnvelope((envelope) => this.handleEnvelope(envelope))
    return client
  }

  private handleEnvelope(envelope: WorkbenchCodexRpcEnvelope): void {
    const method = envelope.method
    const params = asRecord(envelope.params)
    if (!method) return

    if (envelope.id !== undefined && method === 'item/tool/requestUserInput') {
      void this.handleInputRequest(envelope.id, params)
      return
    }
    if (envelope.id !== undefined && method === 'item/tool/call') {
      void this.handleDynamicToolCall(envelope.id, params)
      return
    }
    if (envelope.id !== undefined && method === 'mcpServer/elicitation/request') {
      void this.handleMcpElicitation(envelope.id, params)
      return
    }
    if (envelope.id !== undefined && method === 'item/permissions/requestApproval') {
      void this.handlePermissionsRequest(envelope.id, params)
      return
    }
    if (envelope.id !== undefined && isApprovalMethod(method)) {
      void this.handleApprovalRequest(envelope.id, method, params)
      return
    }

    if (method === 'transport/error') {
      this.removeClientListener?.()
      this.removeClientListener = null
      this.client = null
      for (const active of this.activeByThread.values()) {
        this.interactions.cancelSession(active.input.sessionId, 'Codex app-server 连接已断开。')
        active.reject(new Error('Codex app-server 连接已断开。'))
      }
      this.activeByThread.clear()
      return
    }

    const active = this.findActiveRun(params)
    if (!active) return
    if (method === 'item/agentMessage/delta') {
      const text = readString(params.delta)
      if (text) active.input.events.emitTextDelta(text)
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const text = readString(params.delta)
      if (text) active.input.events.emitReasoningDelta({
        id: readString(params.itemId) ?? 'codex-reasoning',
        text,
      })
      return
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const id = readString(params.itemId)
      const chunk = readString(params.delta)
      if (id && chunk) active.input.events.emitToolProgress({ toolCallId: id, chunk })
      return
    }
    if (method === 'item/started') {
      this.emitToolStart(active, asRecord(params.item))
      return
    }
    if (method === 'item/completed') {
      this.emitToolDone(active, asRecord(params.item))
      return
    }
    if (method === 'turn/plan/updated') {
      this.emitPlanUpdate(active, params)
      return
    }
    if (method === 'turn/started') {
      active.turnId = readString(asRecord(params.turn).id) ?? active.turnId
      return
    }
    if (method === 'turn/completed') {
      const status = readString(asRecord(params.turn).status)
      this.activeByThread.delete(active.threadId)
      if (status === 'failed') active.reject(new Error('Codex turn 执行失败。'))
      else active.resolve(status === 'interrupted' ? 'aborted' : 'completed')
      return
    }
    if (method === 'error' && params.willRetry !== true) {
      this.activeByThread.delete(active.threadId)
      active.reject(new Error(readString(asRecord(params.error).message) ?? 'Codex 运行失败。'))
      return
    }
  }

  private async handleInputRequest(
    rpcId: WorkbenchCodexRpcId,
    params: Record<string, unknown>
  ): Promise<void> {
    const threadId = readString(params.threadId) ?? readString(params.conversationId)
    const active = threadId ? this.activeByThread.get(threadId) : null
    if (!active || !this.client) {
      this.client?.respond(rpcId, { answers: {} })
      return
    }
    const questions = normalizeCodexQuestions(params.questions)
    try {
      const answers = await this.interactions.requestInput({
        sessionId: active.input.sessionId,
        executionId: active.input.executionId,
        questions,
        events: active.input.events,
        signal: active.input.abortSignal,
      })
      this.client.respond(rpcId, {
        answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [
          id,
          { answers: values },
        ])),
      })
    } catch {
      this.client.respond(rpcId, { answers: {} })
    }
  }

  private async handleApprovalRequest(
    rpcId: WorkbenchCodexRpcId,
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const legacy = method === 'applyPatchApproval' || method === 'execCommandApproval'
    const threadId = readString(params.threadId) ?? readString(params.conversationId)
    const active = threadId ? this.activeByThread.get(threadId) : null
    if (!active || !this.client) {
      this.client?.respond(rpcId, {
        decision: legacy ? { denied: { rejection: 'Workbench 会话已结束。' } } : 'decline',
      })
      return
    }
    const command = readString(params.command)
    const reason = readString(params.reason)
    const fileChange = method.includes('fileChange') || method === 'applyPatchApproval'
    const subject = command ?? reason ?? (fileChange ? '应用文件变更' : '执行命令')
    try {
      const decision = await this.interactions.requestConfirmation({
        sessionId: active.input.sessionId,
        executionId: active.input.executionId,
        message: `Codex 请求${fileChange ? '修改文件' : '执行命令'}：${subject}`,
        categoryId: fileChange ? 'file-change' : 'command',
        categoryLabel: fileChange ? '文件变更' : '命令执行',
        toolName: fileChange ? 'project:edit' : 'project:run',
        events: active.input.events,
        signal: active.input.abortSignal,
      })
      this.client.respond(rpcId, {
        decision: legacy
          ? decision.approved
            ? 'approved'
            : { denied: { rejection: decision.message ?? '用户拒绝了这次操作。' } }
          : decision.approved ? 'accept' : 'decline',
      })
    } catch {
      this.client.respond(rpcId, {
        decision: legacy ? { denied: { rejection: '确认已取消。' } } : 'decline',
      })
    }
  }

  private async handlePermissionsRequest(
    rpcId: WorkbenchCodexRpcId,
    params: Record<string, unknown>
  ): Promise<void> {
    const threadId = readString(params.threadId)
    const active = threadId ? this.activeByThread.get(threadId) : null
    if (!active || !this.client) {
      this.client?.respond(rpcId, deniedPermissions())
      return
    }
    const permissions = asRecord(params.permissions)
    const reason = readString(params.reason)
    const summary = formatPermissionSummary(permissions)
    try {
      const decision = await this.interactions.requestConfirmation({
        sessionId: active.input.sessionId,
        executionId: active.input.executionId,
        message: [
          'Codex 请求本轮使用额外权限。',
          reason,
          summary,
        ].filter(Boolean).join('\n'),
        categoryId: 'additional-permissions',
        categoryLabel: '额外权限',
        toolName: 'project:run',
        events: active.input.events,
        signal: active.input.abortSignal,
      })
      this.client.respond(rpcId, decision.approved
        ? { permissions, scope: 'turn', strictAutoReview: true }
        : deniedPermissions())
    } catch {
      this.client.respond(rpcId, deniedPermissions())
    }
  }

  private async handleMcpElicitation(
    rpcId: WorkbenchCodexRpcId,
    params: Record<string, unknown>
  ): Promise<void> {
    const threadId = readString(params.threadId)
    const active = threadId ? this.activeByThread.get(threadId) : null
    if (!active || !this.client) {
      this.client?.respond(rpcId, { action: 'cancel' })
      return
    }
    const message = readString(params.message) ?? '外部工具需要补充信息。'
    const mode = readString(params.mode)
    try {
      if (mode === 'url') {
        const url = readString(params.url)
        const decision = await this.interactions.requestConfirmation({
          sessionId: active.input.sessionId,
          executionId: active.input.executionId,
          message: `${message}${url ? `\n${url}` : ''}`,
          categoryId: 'external-login',
          categoryLabel: '打开外部页面',
          toolName: 'web:read',
          events: active.input.events,
          signal: active.input.abortSignal,
        })
        if (!decision.approved || !url) {
          this.client.respond(rpcId, { action: 'decline' })
          return
        }
        await this.openExternal(url)
        this.client.respond(rpcId, { action: 'accept' })
        return
      }
      const schema = asRecord(params.requestedSchema)
      const questions = normalizeMcpQuestions(message, schema)
      const answers = await this.interactions.requestInput({
        sessionId: active.input.sessionId,
        executionId: active.input.executionId,
        questions,
        events: active.input.events,
        signal: active.input.abortSignal,
      })
      this.client.respond(rpcId, {
        action: 'accept',
        content: buildMcpAnswerContent(schema, answers),
      })
    } catch {
      this.client?.respond(rpcId, { action: 'cancel' })
    }
  }

  private async handleDynamicToolCall(
    rpcId: WorkbenchCodexRpcId,
    params: Record<string, unknown>
  ): Promise<void> {
    const threadId = readString(params.threadId)
    const active = threadId ? this.activeByThread.get(threadId) : null
    if (!active || !this.client) {
      this.client?.respond(rpcId, {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Workbench 会话已结束。' }],
      })
      return
    }
    const toolName = readString(params.tool) ?? ''
    try {
      const result = await this.extensionTools.execute(
        active.input.projectRoot,
        toolName,
        params.arguments
      )
      this.client.respond(rpcId, {
        success: true,
        contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
      })
    } catch (error) {
      this.client.respond(rpcId, {
        success: false,
        contentItems: [{
          type: 'inputText',
          text: error instanceof Error ? error.message : 'Workbench 扩展工具执行失败。',
        }],
      })
    }
  }

  private findActiveRun(params: Record<string, unknown>): ActiveCodexRun | null {
    const threadId = readString(params.threadId)
    if (threadId) return this.activeByThread.get(threadId) ?? null
    if (this.activeByThread.size === 1) return [...this.activeByThread.values()][0] ?? null
    return null
  }

  private emitToolStart(active: ActiveCodexRun, item: Record<string, unknown>): void {
    const id = readString(item.id)
    const type = readString(item.type)
    if (!id || !type || type === 'agentMessage' || type === 'reasoning') return
    const names: Record<string, string> = {
      commandExecution: 'project:run',
      fileChange: 'project:edit',
      collabAgentToolCall: 'agent:dispatch',
      webSearch: 'web:search',
      imageView: 'view_image',
      plan: 'plan:update',
      dynamicToolCall: `dynamic:${String(item.tool ?? 'tool')}`,
      mcpToolCall: `mcp:${String(item.server ?? 'server')}/${String(item.tool ?? 'tool')}`,
    }
    if (type === 'dynamicToolCall' && item.tool === ProjectCodeSearchToolName) {
      names.dynamicToolCall = ProjectCodeToolIdentity
    }
    active.input.events.emitToolStart({
      toolCallId: id,
      toolName: names[type] ?? type,
      args: type === 'commandExecution'
        ? { command: item.command, cwd: item.cwd }
        : type === 'fileChange'
          ? { changes: item.changes, changedFiles: fileChangePaths(item.changes) }
          : type === 'webSearch'
            ? { query: item.query }
            : type === 'imageView'
              ? { path: item.path }
              : type === 'collabAgentToolCall'
                ? { tool: item.tool, prompt: item.prompt, model: item.model }
                : type === 'plan'
                  ? { explanation: item.text }
                  : asRecord(item.arguments),
    })
  }

  private emitToolDone(active: ActiveCodexRun, item: Record<string, unknown>): void {
    const id = readString(item.id)
    const type = readString(item.type)
    if (!id || !type || type === 'agentMessage' || type === 'reasoning') return
    const status = readString(item.status)
    active.input.events.emitToolDone({
      toolCallId: id,
      result: presentCodexToolResult(type, item),
      error: optionalWhen(
        status === 'failed' || status === 'declined',
        `${type} ${status === 'declined' ? '被拒绝' : '执行失败'}。`
      ),
    })
  }

  private emitPlanUpdate(active: ActiveCodexRun, params: Record<string, unknown>): void {
    const turnId = readString(params.turnId) ?? active.turnId ?? 'current'
    const toolCallId = `${turnId}:plan`
    const plan = (Array.isArray(params.plan) ? params.plan : []).map(asRecord).flatMap((step) => {
      const title = readString(step.step)
      if (!title) return []
      return [{
        step: title,
        status: step.status === 'inProgress' ? 'in_progress' : step.status,
      }]
    })
    const args = {
      explanation: readString(params.explanation) ?? undefined,
      plan,
    }
    active.input.events.emitToolStart({ toolCallId, toolName: 'plan:update', args })
    active.input.events.emitToolDone({ toolCallId, result: args })
  }

  private async applyGoal(
    client: WorkbenchCodexAppServerClient,
    threadId: string,
    input: WorkbenchCodexRunInput
  ): Promise<void> {
    try {
      if (input.executionModes.includes('goal')) {
        const objective = latestUserText(input.messages)
        input.events.emitToolStart({
          toolCallId: `${threadId}:goal`,
          toolName: 'goal:create',
          args: { objective },
        })
        await client.request('thread/goal/set', {
          threadId,
          objective,
          status: 'active',
        })
        input.events.emitToolDone({
          toolCallId: `${threadId}:goal`,
          result: { goal: { objective, status: 'active' } },
        })
      } else {
        await client.request('thread/goal/clear', { threadId })
      }
    } catch {
      // 旧版 app-server 没有目标 RPC 时仍按提示词语义继续本轮。
    }
  }
}

function isApprovalMethod(method: string): boolean {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval'
    || method === 'applyPatchApproval'
    || method === 'execCommandApproval'
}

function deniedPermissions(): Record<string, unknown> {
  return {
    permissions: { fileSystem: null, network: null },
    scope: 'turn',
    strictAutoReview: true,
  }
}

function formatPermissionSummary(permissions: Record<string, unknown>): string {
  const fileSystem = asRecord(permissions.fileSystem)
  const network = asRecord(permissions.network)
  const read = Array.isArray(fileSystem.read) ? fileSystem.read.map(String) : []
  const write = Array.isArray(fileSystem.write) ? fileSystem.write.map(String) : []
  const lines = [
    ...(read.length > 0 ? [`读取：${read.join('、')}`] : []),
    ...(write.length > 0 ? [`写入：${write.join('、')}`] : []),
    ...(network.enabled === true ? ['网络访问'] : []),
  ]
  return lines.length > 0 ? lines.join('\n') : '额外的文件系统或网络权限。'
}

function normalizeMcpQuestions(
  message: string,
  schema: Record<string, unknown>
): WorkbenchAgentEngineQuestion[] {
  const properties = asRecord(schema.properties)
  const entries = Object.entries(properties)
  if (entries.length === 0) return [{
    id: 'value',
    header: '补充信息',
    question: message,
    options: [],
  }]
  return entries.map(([id, raw]) => {
    const property = asRecord(raw)
    const values = Array.isArray(property.enum)
      ? property.enum
      : Array.isArray(asRecord(property.items).enum)
        ? asRecord(property.items).enum as unknown[]
        : []
    return {
      id,
      header: readString(property.title) ?? id,
      question: readString(property.description) ?? `${message}\n${id}`,
      options: values.map((value) => ({ label: String(value) })),
      multiple: property.type === 'array',
    }
  })
}

function buildMcpAnswerContent(
  schema: Record<string, unknown>,
  answers: Record<string, string[]>
): Record<string, unknown> {
  const properties = asRecord(schema.properties)
  if (Object.keys(properties).length === 0) {
    const raw = answers.value?.join(', ') ?? ''
    try {
      const parsed = JSON.parse(raw) as unknown
      return asRecord(parsed)
    } catch {
      return { value: raw }
    }
  }
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => {
    const property = asRecord(properties[id])
    const value = values[0] ?? ''
    if (property.type === 'array') return [id, values]
    if (property.type === 'boolean') return [id, /^(?:true|yes|1|是)$/iu.test(value)]
    if (property.type === 'integer') return [id, Number.parseInt(value, 10)]
    if (property.type === 'number') return [id, Number(value)]
    return [id, value]
  }))
}

function fileChangePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).flatMap((change) => {
    const path = readString(change.path)
    return path ? [path] : []
  })
}

function presentCodexToolResult(
  type: string,
  item: Record<string, unknown>
): Record<string, unknown> {
  if (type === 'commandExecution') return {
    command: readString(item.command) ?? '',
    cwd: readString(item.cwd) ?? '',
    exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
    signal: null,
    stdout: readString(item.aggregatedOutput) ?? '',
    stderr: '',
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : 0,
    timedOut: false,
    truncated: false,
    success: item.status === 'completed' && item.exitCode === 0,
    verification: {},
  }
  if (type === 'fileChange') return {
    ...item,
    changed: item.status === 'completed',
    changedFiles: fileChangePaths(item.changes),
  }
  return item
}

function normalizeCodexQuestions(value: unknown): WorkbenchAgentEngineQuestion[] {
  const raw = Array.isArray(value) ? value : []
  return raw.map(asRecord).flatMap((question, index) => {
    const text = readString(question.question)
    if (!text) return []
    const options = (Array.isArray(question.options) ? question.options : [])
      .map(asRecord)
      .flatMap((option) => {
        const label = readString(option.label)
        return label ? [{ label, description: readString(option.description) ?? undefined }] : []
      })
    return [{
      id: readString(question.id) ?? `q${index}`,
      header: readString(question.header) ?? `问题 ${index + 1}`,
      question: text,
      options,
      multiple: false,
    }]
  })
}

function buildCodexPrompt(
  messages: readonly ModelMessage[],
  executionModes: readonly string[],
  resumed: boolean
): string {
  const source = resumed ? messages.slice(-1) : messages
  const conversation = source.map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content)
    return `${message.role.toUpperCase()}:\n${content}`
  }).join('\n\n')
  return `${buildModeInstructions(executionModes)}\n\n${conversation}`
}

function buildModeInstructions(executionModes: readonly string[]): string {
  return [
    'Work directly in the current project. Keep changes focused and report the result concisely.',
    ...(executionModes.includes('goal')
      ? ['VelarOS goal mode is active: keep advancing the objective until it is genuinely achieved.']
      : []),
    ...(executionModes.includes('plan')
      ? ['VelarOS plan mode is active: maintain and update a concise plan while continuing implementation. Plan mode is writable.']
      : []),
  ].join('\n')
}

function latestUserText(messages: readonly ModelMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === 'user')
  if (!latest) return 'Complete the current Workbench task.'
  return typeof latest.content === 'string' ? latest.content : JSON.stringify(latest.content)
}

function readThreadId(value: unknown): string | null {
  return readString(asRecord(asRecord(value).thread).id)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
