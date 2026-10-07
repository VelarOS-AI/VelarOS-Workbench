import { AppError } from '@velaros-ai/core/error'

import type { WorkbenchAgentEngineStatus } from '../../shared/workbenchConversation'
import type { WorkbenchEngineConversationRuntime } from '../engines/WorkbenchEngineConversationRuntime'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { WorkbenchConversationRuntimeApi } from './WorkbenchConversationRuntime'

/** 主聊天的控制面，外加外部引擎在本机的情况。 */
export interface WorkbenchConversationDispatcherApi extends WorkbenchConversationRuntimeApi {
  engines(refresh: boolean): Promise<WorkbenchAgentEngineStatus[]>
}

/**
 * 一个会话由谁执行：请求里带了外部引擎的交给引擎运行时，其余是 VelarOS 自己的 Platform 运行时。运行中的
 * 回答、停止按当前在跑的那一边走；目标只有 Platform 会话有。删会话、停项目、关闭两边都做。
 */
export function createWorkbenchConversationDispatcher(
  platform: WorkbenchConversationRuntimeApi,
  engines: WorkbenchEngineConversationRuntime
): WorkbenchConversationDispatcherApi {
  return {
    isRunning: (ref) => engines.has(ref) || platform.isRunning(ref),
    subscribeRunSettled: (listener) => platform.subscribeRunSettled(listener),
    subscribeRunOutcome: (listener) => platform.subscribeRunOutcome(listener),
    submit: (sink, request) =>
      request.engine ? engines.submit(sink, request) : platform.submit(sink, request),
    cancel: (ref) => (engines.has(ref) ? engines.cancel(ref) : platform.cancel(ref)),
    guidance: async (ref, input) => {
      if (engines.has(ref))
        throw new AppError(
          'VALIDATION',
          workbenchMainText('conversation.engineGuidanceUnsupported')
        )
      await platform.guidance(ref, input)
    },
    input: (ref, answer) =>
      engines.has(ref) ? engines.input(ref, answer) : platform.input(ref, answer),
    answer: (ref, requestId, answer) =>
      engines.has(ref)
        ? engines.answer(ref, requestId, answer)
        : platform.answer(ref, requestId, answer),
    listNotes: (ref, input) => platform.listNotes(ref, input),
    readNote: (ref, input) => platform.readNote(ref, input),
    subscribeNotesChanged: (listener) => platform.subscribeNotesChanged(listener),
    getGoal: (ref) => platform.getGoal(ref),
    controlGoal: (ref, input) => platform.controlGoal(ref, input),
    deleteSession: async (ref) => {
      await Promise.all([engines.deleteSession(ref), platform.deleteSession(ref)])
    },
    cancelProject: async (projectRoot) => {
      await Promise.all([engines.cancelProject(projectRoot), platform.cancelProject(projectRoot)])
    },
    close: async () => {
      await Promise.all([engines.close(), platform.close()])
    },
    engines: (refresh) => engines.status(refresh),
  }
}
