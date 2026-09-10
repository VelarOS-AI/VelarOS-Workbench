import { AppError } from '@velaros-ai/core'

import {
  type WorkbenchAgentUiCommand,
  WorkbenchAgentUiNoticeKind,
  type WorkbenchAgentUiRequest,
  type WorkbenchAgentUiResponse,
} from '@shared/workbenchAgentUi'

/**
 * Agent 界面请求（`workbench:*` 工具）在 renderer 这一侧的落点。
 *
 * 请求随执行事件流到达会话面，但执行它的是页面：打开文件、切左侧面板、加讲解气泡都是页面状态。
 * 页面按项目根登记处理器，会话面收到请求后转过来，做完把回执交回主进程。
 */
export interface WorkbenchAgentUiRequestContext {
  readonly projectRoot: string
  readonly sessionId: string
}

export type WorkbenchAgentUiHandler = (
  command: WorkbenchAgentUiCommand,
  context: WorkbenchAgentUiRequestContext
) => Promise<Record<string, unknown>>

const handlers = new Map<string, WorkbenchAgentUiHandler>()

function normalizeRoot(projectRoot: string): string {
  return projectRoot.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

/** 页面挂载时登记本项目的处理器；返回注销函数（只注销自己登记的那一个）。 */
export function registerWorkbenchAgentUiHandler(
  projectRoot: string,
  handler: WorkbenchAgentUiHandler
): () => void {
  const key = normalizeRoot(projectRoot)
  handlers.set(key, handler)
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** agent 事件里的界面请求；别的事件为 null。 */
export function readWorkbenchAgentUiRequest(event: unknown): WorkbenchAgentUiRequest | null {
  if (!isRecord(event) || event.type !== 'notice' || event.kind !== WorkbenchAgentUiNoticeKind)
    return null
  const payload = event.payload
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== 'string' ||
    typeof payload.executionId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    !isRecord(payload.command) ||
    typeof payload.command.type !== 'string'
  )
    return null
  return payload as unknown as WorkbenchAgentUiRequest
}

/** 交给本项目的页面执行；没有页面接手或执行出错时回一条失败回执，模型会读到原因。 */
export async function performWorkbenchAgentUiRequest(
  projectRoot: string,
  request: WorkbenchAgentUiRequest
): Promise<WorkbenchAgentUiResponse> {
  const handler = handlers.get(normalizeRoot(projectRoot))
  const identity = { requestId: request.requestId, executionId: request.executionId }
  if (!handler)
    return { ...identity, ok: false, message: 'The Workbench window for this project is not ready.' }
  try {
    const data = await handler(request.command, { projectRoot, sessionId: request.sessionId })
    return { ...identity, ok: true, data }
  } catch (error) {
    return { ...identity, ok: false, message: AppError.from(error).message }
  }
}
