import type { ModelMessage } from 'ai'

import type { ExecutionEventBus } from '@velaros-ai/agent'

import type { WorkbenchAgentEngineModelCatalog } from '../../../shared/workbenchResourcePlugins'
import type { WorkbenchAgentEngineId } from '../identity'

import type { WorkbenchAgentEngineSessionStore } from './WorkbenchAgentEngineSessionStore'
import type { WorkbenchAgentExtensionTools } from './WorkbenchAgentExtensionTools'
import { WorkbenchAgentPluginResolver } from './WorkbenchAgentPluginResolver'
import { WorkbenchClaudeAgentRuntime } from './WorkbenchClaudeAgentRuntime'
import { WorkbenchCodexAgentRuntime } from './WorkbenchCodexAgentRuntime'
import { WorkbenchEngineInteractionBroker } from './WorkbenchEngineInteractionBroker'

interface WorkbenchAgentEngineRunInput {
  executionId: string
  engineId: WorkbenchAgentEngineId
  sessionId: string
  projectRoot: string
  messages: ModelMessage[]
  executionModes: readonly string[]
  model?: string
  events: ExecutionEventBus
  abortSignal: AbortSignal
}

type WorkbenchAgentEngineRunResult =
  | { status: 'completed' }
  | { status: 'aborted' | 'error' }

/**
 * Workbench 外部 Agent 插件的宿主协调层。
 *
 * Claude 与 Codex 各自保留原生会话、编辑、检索和命令工具；Workbench 只补充
 * VelarOS 目标/计划语义以及统一的等待输入界面，避免重复注册引擎已有工具。
 */
export class WorkbenchAgentPluginRuntime {
  private readonly running = new Set<string>()
  private readonly runningProjects = new Set<string>()
  private readonly interactions = new WorkbenchEngineInteractionBroker()
  private readonly claude: WorkbenchClaudeAgentRuntime
  private readonly codex: WorkbenchCodexAgentRuntime

  public constructor(
    sessions: WorkbenchAgentEngineSessionStore,
    extensionTools: WorkbenchAgentExtensionTools,
    openExternal: (url: string) => Promise<void>,
    private readonly isPluginEnabled: (engineId: WorkbenchAgentEngineId) => boolean,
    productVersion: string,
    pluginResolver = new WorkbenchAgentPluginResolver()
  ) {
    this.claude = new WorkbenchClaudeAgentRuntime(
      this.interactions,
      sessions,
      extensionTools,
      pluginResolver
    )
    this.codex = new WorkbenchCodexAgentRuntime(
      this.interactions,
      sessions,
      extensionTools,
      openExternal,
      productVersion
    )
  }

  public resolveInput(sessionId: string, answer: string): boolean {
    return this.interactions.resolveInput(sessionId, answer)
  }

  public resolveConfirmation(
    sessionId: string,
    approved: boolean,
    rejectionMessage?: string
  ): boolean {
    return this.interactions.resolveConfirmation(sessionId, approved, rejectionMessage)
  }

  public listModels(
    engineId: WorkbenchAgentEngineId
  ): Promise<WorkbenchAgentEngineModelCatalog> {
    if (!this.isPluginEnabled(engineId)) return Promise.resolve({
      engineId,
      available: false,
      reason: engineId === 'claude-code'
        ? '请先在 Workbench 插件页安装并启用 Claude Agent。'
        : '请先在 Workbench 插件页安装并启用 ChatGPT。',
      models: [],
    })
    return engineId === 'claude-code' ? this.claude.listModels() : this.codex.listModels()
  }

  public async run(input: WorkbenchAgentEngineRunInput): Promise<WorkbenchAgentEngineRunResult> {
    if (!this.isPluginEnabled(input.engineId)) {
      throw new Error(input.engineId === 'claude-code'
        ? '请先安装并启用 Claude Agent 插件。'
        : '请先安装并启用 ChatGPT 插件。')
    }
    if (this.running.has(input.sessionId)) {
      throw new Error('这个外部 Agent 会话已有任务正在运行。')
    }
    if (this.runningProjects.has(input.projectRoot)) {
      throw new Error('这个项目已有一个外部 Agent 正在运行，请先等待或停止它。')
    }

    this.running.add(input.sessionId)
    this.runningProjects.add(input.projectRoot)
    try {
      const result = input.engineId === 'claude-code'
        ? await this.claude.run(input)
        : await this.codex.run(input)
      if (result.status === 'aborted') {
        input.events.emitRuntime({
          kind: 'aborted',
          message: '已停止。',
          executionId: input.executionId,
        })
        return result
      }
      input.events.emitRuntime({ kind: 'done' })
      return result
    } catch (error) {
      if (input.abortSignal.aborted) {
        input.events.emitRuntime({
          kind: 'aborted',
          message: '已停止。',
          executionId: input.executionId,
        })
        return { status: 'aborted' }
      }
      const message = error instanceof Error ? error.message : '外部 Agent 运行失败。'
      input.events.emitRuntime({ kind: 'error', message })
      throw error
    } finally {
      this.interactions.cancelSession(input.sessionId, '本次执行已结束。')
      this.running.delete(input.sessionId)
      this.runningProjects.delete(input.projectRoot)
    }
  }

  public async dispose(): Promise<void> {
    this.interactions.dispose()
    this.claude.close()
    this.codex.close()
    this.running.clear()
    this.runningProjects.clear()
  }
}
