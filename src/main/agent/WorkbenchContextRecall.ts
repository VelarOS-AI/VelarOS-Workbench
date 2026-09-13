import {
  ChatContextRetrievalService,
  type ContextGovernanceSessionRegistry,
  type ToolConversationContextApi,
} from '@velaros-ai/agent'

import { WorkbenchContextPayloadStore } from './context/WorkbenchContextPayloadStore'
export { WorkbenchContextPayloadStore } from './context/WorkbenchContextPayloadStore'

export interface WorkbenchContextRecall {
  readonly payloadStore: WorkbenchContextPayloadStore
  /** 一轮执行的会话口；召回请求一律落到发起这一轮的会话与执行范围上。 */
  conversationFor(input: { sessionId: string; executionId: string }): ToolConversationContextApi
}

export function createWorkbenchContextRecall(
  governanceSessions: ContextGovernanceSessionRegistry,
  payloadStore = new WorkbenchContextPayloadStore(),
): WorkbenchContextRecall {
  const service = new ChatContextRetrievalService(
    payloadStore,
    // 会话消息与检索索引不在主进程：历史搜索如实返回空，取回页出的原文不受影响。
    { loadSessionMessages: async () => [], loadSessionMessage: async () => null },
    governanceSessions,
    { loadFresh: async () => null, save: async () => {} },
  )
  return {
    payloadStore,
    conversationFor: ({ sessionId, executionId }) => {
      const scope = { sessionId, retrievalScopeId: executionId }
      return {
        retrieveContextPayload: (input) => service.retrieveContextPayload({ ...input, ...scope }),
        searchConversationHistory: (input) =>
          service.searchConversationHistory({ ...input, ...scope }),
        readEvidence: (input) => service.readEvidence({ ...input, ...scope }),
        readToolPayload: (input) => service.readToolPayload({ ...input, ...scope }),
        searchTerminalOutput: (input) => service.searchTerminalOutput({ ...input, ...scope }),
      }
    },
  }
}
